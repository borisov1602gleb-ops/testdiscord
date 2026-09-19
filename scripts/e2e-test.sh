#!/usr/bin/env bash
# Полный сценарий из раздела 13 спецификации:
# создание сообщества → инвайт → открытие инвайта гостем → подключение гостя
# к звонку без регистрации → регистрация гостя по коду → вступление в сообщество
# → выход из звонка с корректным duration_sec → отправка сообщения.
#
# Требует поднятый backend (EXPOSE_DEV_CODE=true) и доступ к БД для финальной
# проверки events_bronze.
set -euo pipefail

API="${API:-http://localhost:3000}"
PSQL="${PSQL:-psql}"
DB="${DB:-community}"
STAMP="$(date +%s)"
OWNER_EMAIL="owner-${STAMP}@example.com"
GUEST_EMAIL="guest-${STAMP}@example.com"
ANON_ID="anon-${STAMP}"

step() { printf '\n=== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

login() {
  local email="$1" anon="${2:-}"
  local code payload
  code="$(curl -sf -X POST "$API/auth/send-code" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\"}" | jq -r '.dev_code')"
  [ "$code" != "null" ] || fail "backend не отдал dev_code (нужен EXPOSE_DEV_CODE=true)"
  payload="{\"email\":\"$email\",\"code\":\"$code\""
  [ -n "$anon" ] && payload="$payload,\"anonymous_id\":\"$anon\""
  payload="$payload}"
  curl -sf -X POST "$API/auth/verify-code" -H 'content-type: application/json' -d "$payload"
}

step "1. Регистрация владельца сообщества ($OWNER_EMAIL)"
OWNER="$(login "$OWNER_EMAIL")"
OWNER_TOKEN="$(echo "$OWNER" | jq -r '.token')"
echo "$OWNER" | jq -c '{user_id: .user.id, is_new_user}'

step "2. Создание сообщества (+ text/voice каналы автоматически)"
COMMUNITY="$(curl -sf -X POST "$API/communities" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER_TOKEN" -d '{"name":"Гейминг"}')"
COMMUNITY_ID="$(echo "$COMMUNITY" | jq -r '.community.id')"
TEXT_CHANNEL="$(echo "$COMMUNITY" | jq -r '.channels[] | select(.type=="text") | .id')"
VOICE_CHANNEL="$(echo "$COMMUNITY" | jq -r '.channels[] | select(.type=="voice") | .id')"
echo "$COMMUNITY" | jq -c '{community: .community.name, channels: [.channels[].type]}'
[ -n "$TEXT_CHANNEL" ] && [ -n "$VOICE_CHANNEL" ] || fail "каналы не созданы"

step "3. Создание инвайт-ссылки"
INVITE_ID="$(curl -sf -X POST "$API/invites" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -d "{\"community_id\":\"$COMMUNITY_ID\",\"max_uses\":10}" | jq -r '.invite.id')"
echo "invite_id: $INVITE_ID"

step "4. Гость открывает инвайт (без регистрации)"
curl -sf "$API/invites/$INVITE_ID?anonymous_id=$ANON_ID" -H "x-device-id: device-$STAMP" \
  | jq -c '{community: .community.name, valid, voice_channel: .voice_channel.name}'

step "5. Гость подключается к звонку без регистрации"
CALL_ID="$(curl -sf -X POST "$API/calls" -H 'content-type: application/json' \
  -d "{\"channel_id\":\"$VOICE_CHANNEL\",\"invite_id\":\"$INVITE_ID\",\"anonymous_id\":\"$ANON_ID\"}" \
  | jq -r '.call.id')"
JOIN="$(curl -sf -X POST "$API/calls/$CALL_ID/join" -H 'content-type: application/json' \
  -d "{\"anonymous_id\":\"$ANON_ID\",\"invite_id\":\"$INVITE_ID\"}")"
echo "$JOIN" | jq -c '{call_id: .participant.call_id, user_id: .participant.user_id,
  anonymous_id: .participant.anonymous_id, livekit_token: (.livekit.token | length > 0)}'
[ "$(echo "$JOIN" | jq -r '.participant.user_id')" = "null" ] || fail "гость не должен иметь user_id"

step "6. Общение в звонке (2 сек)"
sleep 2

step "7. Гость регистрируется по коду ($GUEST_EMAIL), anonymous_id привязывается"
GUEST="$(login "$GUEST_EMAIL" "$ANON_ID")"
GUEST_TOKEN="$(echo "$GUEST" | jq -r '.token')"
GUEST_ID="$(echo "$GUEST" | jq -r '.user.id')"
echo "$GUEST" | jq -c '{user_id: .user.id, is_new_user, linked_call_participants}'
[ "$(echo "$GUEST" | jq -r '.linked_call_participants')" -ge 1 ] \
  || fail "участие в звонке не привязано к новому user_id (edge case 12.4)"

step "8. Гость вступает в сообщество по тому же инвайту"
curl -sf -X POST "$API/invites/$INVITE_ID/join" -H "authorization: Bearer $GUEST_TOKEN" \
  | jq -c '{role: .member.role, invite_id: .member.invite_id, already_member}'

step "9. Выход из звонка — duration_sec должен посчитаться"
LEAVE="$(curl -sf -X POST "$API/calls/$CALL_ID/leave" -H 'content-type: application/json' \
  -H "authorization: Bearer $GUEST_TOKEN" -d '{}')"
echo "$LEAVE" | jq -c '{user_id: .participant.user_id, duration_sec: .participant.duration_sec}'
DURATION="$(echo "$LEAVE" | jq -r '.participant.duration_sec')"
[ "$DURATION" -ge 1 ] || fail "duration_sec потерялся: $DURATION"
[ "$(echo "$LEAVE" | jq -r '.participant.user_id')" = "$GUEST_ID" ] \
  || fail "участие не привязано к зарегистрированному пользователю"

step "10. Отправка сообщения в текстовый канал"
curl -sf -X POST "$API/messages" -H 'content-type: application/json' \
  -H "authorization: Bearer $GUEST_TOKEN" \
  -d "{\"channel_id\":\"$TEXT_CHANNEL\",\"content\":\"Привет всем!\"}" \
  | jq -c '{message_id: .message.id, content: .message.content}'
curl -sf "$API/messages?channel_id=$TEXT_CHANNEL" -H "authorization: Bearer $GUEST_TOKEN" \
  | jq -c '{history_size: (.messages | length)}'

step "11. Проверка events_bronze: все 6 типов событий"
EVENTS="$($PSQL -d "$DB" -At -F'|' -c "
  SELECT event_type, count(*)
  FROM events_bronze
  WHERE payload->>'community_id' = '$COMMUNITY_ID'
     OR payload->>'user_id' IN ('$GUEST_ID')
  GROUP BY event_type ORDER BY event_type;")"
echo "$EVENTS"

for type in invite_link_opened call_joined registration_completed community_joined message_sent call_participated; do
  echo "$EVENTS" | grep -q "^$type|" || fail "нет события $type в events_bronze"
done

step "12. Обязательные поля событий заполнены"
$PSQL -d "$DB" -At -F'|' -c "
  SELECT event_type,
         payload ? 'event_id' AND payload ? 'timestamp'
           AND (payload->>'user_id' IS NOT NULL OR payload->>'anonymous_id' IS NOT NULL) AS ok
  FROM events_bronze
  WHERE payload->>'community_id' = '$COMMUNITY_ID' OR payload->>'user_id' = '$GUEST_ID'
  ORDER BY received_at;" | tee /dev/stderr | grep -q '|f$' && fail "есть события с незаполненными обязательными полями"

printf '\n✅ Полный сценарий раздела 13 пройден без ошибок\n'
