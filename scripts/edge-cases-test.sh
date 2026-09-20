#!/usr/bin/env bash
# Проверка граничных случаев и правил доступа — всё, что легко сломать
# при доработках и трудно заметить глазами.
#
# Каждая строка проверяет одно правило: что нельзя сделать, чего нельзя
# получить и что должно вернуться вместо внутренней ошибки сервера.
#
# Требует поднятый backend с EXPOSE_DEV_CODE=true:
#   ./scripts/edge-cases-test.sh
set -uo pipefail

API="${API:-http://localhost:3000}"
S="$(date +%s)-$$"
FAILED=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() { # check «что проверяем» ожидаемое фактическое
  if [ "$2" = "$3" ]; then
    printf 'ok   %s: %s\n' "$1" "$3"
  else
    printf 'FAIL %s: %s (ожидалось %s)\n' "$1" "$3" "$2"
    FAILED=$((FAILED + 1))
  fi
}

login() {
  local email="$1" code
  code="$(curl -sf -X POST "$API/auth/send-code" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\"}" | jq -r '.dev_code')"
  [ "$code" != "null" ] || { echo "backend не отдал dev_code (нужен EXPOSE_DEV_CODE=true)"; exit 1; }
  curl -sf -X POST "$API/auth/verify-code" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"code\":\"$code\"}" | jq -r .token
}

status() { # status МЕТОД URL [тело] [токен]
  local method="$1" url="$2" body="${3:-}" token="${4:-}"
  local args=(-s -o "$TMP/out.json" -w '%{http_code}' -X "$method" "$url" -H 'content-type: application/json')
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

OWNER="$(login "edge-owner-$S@example.com")"
MEMBER="$(login "edge-member-$S@example.com")"
OUTSIDER="$(login "edge-outsider-$S@example.com")"

COMMUNITY="$(curl -sf -X POST "$API/communities" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d '{"name":"Границы"}')"
CID="$(echo "$COMMUNITY" | jq -r .community.id)"
TEXT="$(echo "$COMMUNITY" | jq -r '.channels[]|select(.type=="text")|.id')"
VOICE="$(echo "$COMMUNITY" | jq -r '.channels[]|select(.type=="voice")|.id')"

echo '--- доступ ---'
check "не-участник не видит сообщество" 403 "$(status GET "$API/communities/$CID" '' "$OUTSIDER")"
check "не-участник не пишет в канал" 403 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"content\":\"привет\"}" "$OUTSIDER")"
check "без токена в сообщество не попасть" 401 "$(status GET "$API/communities/$CID")"

INVITE="$(curl -sf -X POST "$API/invites" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d "{\"community_id\":\"$CID\",\"max_uses\":1}" | jq -r .invite.id)"
curl -sf -X POST "$API/invites/$INVITE/join" -H 'content-type: application/json' \
  -H "authorization: Bearer $MEMBER" -d '{}' > /dev/null

check "участник не владелец — аналитика закрыта" 403 \
  "$(status GET "$API/communities/$CID/analytics" '' "$MEMBER")"
check "владелец видит аналитику" 200 "$(status GET "$API/communities/$CID/analytics" '' "$OWNER")"

echo '--- приглашения ---'
check "исчерпанное приглашение невалидно" false \
  "$(curl -sf "$API/invites/$INVITE" | jq -r .valid)"
CALL="$(curl -sf -X POST "$API/calls" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d "{\"channel_id\":\"$VOICE\"}" | jq -r .call.id)"
check "гость по исчерпанному приглашению в звонок не входит" 410 \
  "$(status POST "$API/calls/$CALL/join" "{\"invite_id\":\"$INVITE\",\"anonymous_id\":\"edge-anon-$S\"}")"
check "мусор в expires_at — ошибка клиента, не сервера" 400 \
  "$(status POST "$API/invites" "{\"community_id\":\"$CID\",\"expires_at\":\"когда-нибудь\"}" "$OWNER")"
check "дробное число использований отклоняется" 400 \
  "$(status POST "$API/invites" "{\"community_id\":\"$CID\",\"max_uses\":1.5}" "$OWNER")"

echo '--- звонки ---'
FRESH="$(curl -sf -X POST "$API/invites" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d "{\"community_id\":\"$CID\"}" | jq -r .invite.id)"
ANON="edge-guest-$S"
check "гость по действующему приглашению входит" 201 \
  "$(status POST "$API/calls/$CALL/join" "{\"invite_id\":\"$FRESH\",\"anonymous_id\":\"$ANON\"}")"
check "посторонний не закроет участие гостя" 404 \
  "$(status POST "$API/calls/$CALL/leave" "{\"anonymous_id\":\"$ANON\"}" "$OUTSIDER")"
check "гость закрывает своё участие сам" 200 \
  "$(status POST "$API/calls/$CALL/leave" "{\"anonymous_id\":\"$ANON\"}")"
check "повторный выход — не ошибка сервера" 404 \
  "$(status POST "$API/calls/$CALL/leave" "{\"anonymous_id\":\"$ANON\"}")"

# Одна сессия на голосовой канал: несколько одновременных запросов должны
# вернуть один и тот же звонок.
for _ in 1 2 3 4 5; do
  curl -sf -X POST "$API/calls" -H 'content-type: application/json' \
    -H "authorization: Bearer $OWNER" -d "{\"channel_id\":\"$VOICE\"}" | jq -r .call.id >> "$TMP/calls.txt" &
done
wait
check "одновременные запросы дают один звонок" 1 "$(sort -u "$TMP/calls.txt" | wc -l | tr -d ' ')"

echo '--- сообщения ---'
jq -nc --arg ch "$TEXT" --arg c "$(head -c 3000 /dev/zero | tr '\0' 'a')" \
  '{channel_id:$ch,content:$c}' > "$TMP/long.json"
check "слишком длинное сообщение отклоняется" 400 \
  "$(curl -s -o "$TMP/out.json" -w '%{http_code}' -X POST "$API/messages" \
     -H 'content-type: application/json' -H "authorization: Bearer $OWNER" --data-binary @"$TMP/long.json")"
check "причина понятна клиенту" content_too_long "$(jq -r .error "$TMP/out.json")"

# Файлом, а не аргументом: 200 000 символов в командную строку не влезают.
head -c 200000 /dev/zero | tr '\0' 'a' > "$TMP/huge.txt"
jq -nc --arg ch "$TEXT" --rawfile c "$TMP/huge.txt" \
  '{channel_id:$ch,content:$c}' > "$TMP/huge.json"
check "гигантское тело запроса — 413, а не 500" 413 \
  "$(curl -s -o "$TMP/out.json" -w '%{http_code}' -X POST "$API/messages" \
     -H 'content-type: application/json' -H "authorization: Bearer $OWNER" --data-binary @"$TMP/huge.json")"

check "битый JSON — ошибка клиента" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/messages" \
     -H 'content-type: application/json' -H "authorization: Bearer $OWNER" -d '{не json')"
check "отрицательный limit не роняет историю" 200 \
  "$(status GET "$API/messages?channel_id=$TEXT&limit=-5" '' "$OWNER")"
check "нечитаемый id канала — 400" 400 "$(status GET "$API/messages?channel_id=abc" '' "$OWNER")"

echo '--- вход по коду ---'
BRUTE="edge-brute-$S@example.com"
REAL="$(curl -sf -X POST "$API/auth/send-code" -H 'content-type: application/json' \
  -d "{\"email\":\"$BRUTE\"}" | jq -r .dev_code)"
for i in 1 2 3 4 5; do
  status POST "$API/auth/verify-code" "{\"email\":\"$BRUTE\",\"code\":\"00000$i\"}" > /dev/null
done
check "после пяти неудач код гаснет" 429 \
  "$(status POST "$API/auth/verify-code" "{\"email\":\"$BRUTE\",\"code\":\"$REAL\"}")"
check "повторная отправка кода ограничена" 429 \
  "$(status POST "$API/auth/send-code" "{\"email\":\"edge-owner-$S@example.com\"}")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✅ Все граничные случаи ведут себя как задумано"
else
  echo "❌ Провалено проверок: $FAILED"
  exit 1
fi
