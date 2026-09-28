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

echo '--- состав и настройки сообщества ---'
check "участник видит состав сообщества" 200 "$(status GET "$API/communities/$CID/members" '' "$MEMBER")"
check "посторонний состав не видит" 403 "$(status GET "$API/communities/$CID/members" '' "$OUTSIDER")"
check "владелец переименовывает сообщество" 200 \
  "$(status PATCH "$API/communities/$CID" '{"name":"Границы и порядок"}' "$OWNER")"
check "участник переименовать не может" 403 \
  "$(status PATCH "$API/communities/$CID" '{"name":"Моё теперь"}' "$MEMBER")"
check "пустое название отклоняется" 400 "$(status PATCH "$API/communities/$CID" '{"name":"  "}' "$OWNER")"
check "владелец создаёт канал" 201 \
  "$(status POST "$API/communities/$CID/channels" '{"name":"патчноуты","type":"text"}' "$OWNER")"
check "участник канал не создаёт" 403 \
  "$(status POST "$API/communities/$CID/channels" '{"name":"своё","type":"text"}' "$MEMBER")"
check "выдуманный тип канала отклоняется" 400 \
  "$(status POST "$API/communities/$CID/channels" '{"name":"видеоканал","type":"video"}' "$OWNER")"

echo '--- выход и исключение ---'
LEAVER="$(login "edge-leaver-$S@example.com")"
LEAVER_ID="$(curl -sf "$API/users/me" -H "authorization: Bearer $LEAVER" | jq -r .user.id)"
FRESH_INVITE="$(curl -sf -X POST "$API/invites" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d "{\"community_id\":\"$CID\"}" | jq -r .invite.id)"
curl -sf -X POST "$API/invites/$FRESH_INVITE/join" -H 'content-type: application/json' \
  -H "authorization: Bearer $LEAVER" -d '{}' > /dev/null

check "владелец уйти не может" 400 "$(status DELETE "$API/communities/$CID/members/me" '' "$OWNER")"
check "участник не исключает другого" 403 \
  "$(status DELETE "$API/communities/$CID/members/$LEAVER_ID" '' "$MEMBER")"
check "владелец исключает участника" 200 \
  "$(status DELETE "$API/communities/$CID/members/$LEAVER_ID" '' "$OWNER")"
check "исключённый теряет доступ" 403 "$(status GET "$API/communities/$CID" '' "$LEAVER")"
check "повторное исключение — уже некого" 404 \
  "$(status DELETE "$API/communities/$CID/members/$LEAVER_ID" '' "$OWNER")"
check "участник выходит сам" 200 "$(status DELETE "$API/communities/$CID/members/me" '' "$MEMBER")"

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

echo '--- правка, ответы, реакции, прочтение ---'
CHATTER="$(login "edge-chatter-$S@example.com")"
CHATTER_ID="$(curl -sf "$API/users/me" -H "authorization: Bearer $CHATTER" | jq -r .user.id)"
curl -sf -X POST "$API/invites/$FRESH/join" -H 'content-type: application/json' \
  -H "authorization: Bearer $CHATTER" -d '{}' > /dev/null
OUTSIDER_ID="$(curl -sf "$API/users/me" -H "authorization: Bearer $OUTSIDER" | jq -r .user.id)"

send() { # send ТОКЕН тело → id сообщения
  curl -sf -X POST "$API/messages" -H 'content-type: application/json' \
    -H "authorization: Bearer $1" -d "$2" | jq -r .message.id
}
MSG="$(send "$OWNER" "{\"channel_id\":\"$TEXT\",\"content\":\"@участник привет\",\"mentions\":[\"$CHATTER_ID\",\"$OUTSIDER_ID\"]}")"
check "упомянуть можно только участника" 1 \
  "$(curl -sf "$API/messages?channel_id=$TEXT" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$MSG" '[.messages[]|select(.id==$id)|.mentions[]]|length')"
check "упоминание видно в непрочитанных" 1 \
  "$(curl -sf "$API/communities/$CID/unread" -H "authorization: Bearer $CHATTER" \
     | jq --arg ch "$TEXT" '.channels[]|select(.channel_id==$ch)|.mentions')"
check "чужое сообщение не правится" 403 \
  "$(status PATCH "$API/messages/$MSG" '{"content":"переписал"}' "$CHATTER")"
check "своё сообщение правится" 200 \
  "$(status PATCH "$API/messages/$MSG" '{"content":"поправил"}' "$OWNER")"
check "правка помечается" true "$(jq '.message.edited_at != null' "$TMP/out.json")"
check "список прочитавших — только автору" 403 "$(status GET "$API/messages/$MSG/readers" '' "$CHATTER")"
check "пока никто не прочитал" 0 \
  "$(curl -sf "$API/messages/$MSG/readers" -H "authorization: Bearer $OWNER" | jq '.readers|length')"
# Ответ сам по себе значит «прочитал»: отвечающему ставится отметка.
check "ответ на сообщение из другого канала отклоняется" 400 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"content\":\"ответ\",\"reply_to\":\"$CALL\"}" "$CHATTER")"
check "ответ на сообщение из канала" 201 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"content\":\"ответ\",\"reply_to\":\"$MSG\"}" "$CHATTER")"
check "реакция вне набора отклоняется" 400 "$(status PUT "$API/messages/$MSG/reactions" '{"emoji":"💩"}' "$CHATTER")"
check "реакция ставится" 1 \
  "$(status PUT "$API/messages/$MSG/reactions" '{"emoji":"👍"}' "$CHATTER" > /dev/null; jq '.reactions[0].count' "$TMP/out.json")"
check "повторная реакция снимается" 0 \
  "$(status PUT "$API/messages/$MSG/reactions" '{"emoji":"👍"}' "$CHATTER" > /dev/null; jq '.reactions|length' "$TMP/out.json")"
check "посторонний реакцию не ставит" 403 "$(status PUT "$API/messages/$MSG/reactions" '{"emoji":"👍"}' "$OUTSIDER")"
check "отметка прочтения" 200 "$(status POST "$API/channels/$TEXT/read" '' "$CHATTER")"
check "автор видит, кто прочитал" "$CHATTER_ID" \
  "$(curl -sf "$API/messages/$MSG/readers" -H "authorization: Bearer $OWNER" | jq -r '.readers[0].id')"
check "после прочтения непрочитанных нет" 0 \
  "$(curl -sf "$API/communities/$CID/unread" -H "authorization: Bearer $CHATTER" \
     | jq --arg ch "$TEXT" '.channels[]|select(.channel_id==$ch)|.unread')"
check "посторонний не отмечает прочтение" 403 "$(status POST "$API/channels/$TEXT/read" '' "$OUTSIDER")"
check "участник не удаляет чужое" 403 "$(status DELETE "$API/messages/$MSG" '' "$CHATTER")"
REPLY_ID="$(send "$CHATTER" "{\"channel_id\":\"$TEXT\",\"content\":\"моё\"}")"
check "владелец удаляет чужое (модерация)" 204 "$(status DELETE "$API/messages/$REPLY_ID" '' "$OWNER")"
check "удалённое не правится" 410 "$(status PATCH "$API/messages/$REPLY_ID" '{"content":"вернул"}' "$CHATTER")"
check "текст удалённого не отдаётся" '""' \
  "$(curl -sf "$API/messages?channel_id=$TEXT" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$REPLY_ID" '.messages[]|select(.id==$id)|.content')"

echo '--- подгрузка истории ---'
for i in 1 2 3 4 5; do send "$OWNER" "{\"channel_id\":\"$TEXT\",\"content\":\"страница $i\"}" > /dev/null; done
curl -sf "$API/messages?channel_id=$TEXT&limit=3" -H "authorization: Bearer $OWNER" > "$TMP/page1.json"
OLDEST="$(jq -r '.messages[0].id' "$TMP/page1.json")"
check "первая страница знает, что есть ещё" true "$(jq .has_more "$TMP/page1.json")"
curl -sf "$API/messages?channel_id=$TEXT&limit=3&before=$OLDEST" -H "authorization: Bearer $OWNER" > "$TMP/page2.json"
check "страницы не пересекаются" 0 \
  "$(jq -s '[.[0].messages[].id] - ([.[0].messages[].id] - [.[1].messages[].id]) | length' "$TMP/page1.json" "$TMP/page2.json")"
check "вторая страница старше первой" true \
  "$(jq -s '.[1].messages[-1].created_at <= .[0].messages[0].created_at' "$TMP/page1.json" "$TMP/page2.json")"

echo '--- вложения ---'
printf '\x89PNG\r\n\x1a\n' > "$TMP/pic.png"
upload() { # upload ТОКЕН тип файл → код ответа
  curl -s -o "$TMP/out.json" -w '%{http_code}' -X POST \
    "$API/attachments?community_id=$CID&filename=pic.png" \
    -H "authorization: Bearer $1" -H "content-type: $2" --data-binary @"$3"
}
check "HTML как вложение не принимается" 415 "$(upload "$OWNER" text/html "$TMP/pic.png")"
check "SVG как вложение не принимается" 415 "$(upload "$OWNER" image/svg+xml "$TMP/pic.png")"
check "посторонний не загружает" 403 "$(upload "$OUTSIDER" image/png "$TMP/pic.png")"
head -c 11000000 /dev/zero > "$TMP/big.bin"
check "слишком большой файл — 413" 413 "$(upload "$OWNER" image/png "$TMP/big.bin")"
check "картинка загружается" 201 "$(upload "$OWNER" image/png "$TMP/pic.png")"
ATT_ID="$(jq -r .attachment.id "$TMP/out.json")"
ATT_URL="$(jq -r .attachment.url "$TMP/out.json")"
check "по подписанной ссылке файл отдаётся" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$API$ATT_URL")"
check "браузеру запрещено угадывать тип" nosniff \
  "$(curl -s -D - -o /dev/null "$API$ATT_URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-content-type-options"{print $2}')"
check "без подписи файл не отдаётся" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/attachments/$ATT_ID?exp=9999999999&sig=fake")"
check "чужое вложение не прикрепить" 400 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"attachment_id\":\"$ATT_ID\"}" "$CHATTER")"
check "картинка без подписи отправляется" 201 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"attachment_id\":\"$ATT_ID\"}" "$OWNER")"
check "одно вложение — одно сообщение" 400 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"attachment_id\":\"$ATT_ID\"}" "$OWNER")"

echo '--- треды, закреплённые, поиск, переход к сообщению ---'
ROOT="$(send "$OWNER" "{\"channel_id\":\"$TEXT\",\"content\":\"Корень треда про дедлайн\"}")"
check "ответ в тред" 201 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"content\":\"в треде\",\"thread_id\":\"$ROOT\"}" "$CHATTER")"
THREAD_MSG="$(jq -r .message.id "$TMP/out.json")"
check "тред внутри треда не создаётся" 400 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$TEXT\",\"content\":\"глубже\",\"thread_id\":\"$THREAD_MSG\"}" "$OWNER")"
check "сообщения треда не попадают в общую ленту" 0 \
  "$(curl -sf "$API/messages?channel_id=$TEXT" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$THREAD_MSG" '[.messages[]|select(.id==$id)]|length')"
check "у корня виден счётчик ответов" 1 \
  "$(curl -sf "$API/messages?channel_id=$TEXT" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$ROOT" '.messages[]|select(.id==$id)|.thread_count')"
check "тред читается целиком" 1 \
  "$(curl -sf "$API/messages?channel_id=$TEXT&thread_id=$ROOT" -H "authorization: Bearer $OWNER" | jq '.messages|length')"
check "посторонний тред не читает" 403 "$(status GET "$API/messages?channel_id=$TEXT&thread_id=$ROOT" '' "$OUTSIDER")"
check "участник не закрепляет в сообществе" 403 "$(status PUT "$API/messages/$ROOT/pin" '{"pinned":true}' "$CHATTER")"
check "владелец закрепляет" 200 "$(status PUT "$API/messages/$ROOT/pin" '{"pinned":true}' "$OWNER")"
check "закреплённое видно в списке" "$ROOT" \
  "$(curl -sf "$API/messages/pinned?channel_id=$TEXT" -H "authorization: Bearer $CHATTER" | jq -r '.messages[0].id')"
check "сообщение треда не закрепляется" 400 "$(status PUT "$API/messages/$THREAD_MSG/pin" '{"pinned":true}' "$OWNER")"
check "поиск находит по слову" "$ROOT" \
  "$(curl -sf "$API/messages/search?community_id=$CID&q=%D0%B4%D0%B5%D0%B4%D0%BB%D0%B0%D0%B9%D0%BD" \
     -H "authorization: Bearer $CHATTER" | jq -r '.messages[0].id')"
check "символ % в поиске — не шаблон" 0 \
  "$(curl -sf "$API/messages/search?community_id=$CID&q=%25%25" -H "authorization: Bearer $OWNER" | jq '.messages|length')"
check "слишком короткий запрос" 400 "$(status GET "$API/messages/search?community_id=$CID&q=a" '' "$OWNER")"
check "посторонний не ищет в сообществе" 403 \
  "$(status GET "$API/messages/search?community_id=$CID&q=%D0%B4%D0%B5%D0%B4" '' "$OUTSIDER")"
check "переход к старому сообщению" true \
  "$(curl -sf "$API/messages?channel_id=$TEXT&around=$OLDEST" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$OLDEST" '(.messages|map(.id)|index($id)) != null')"

echo '--- личные сообщения ---'
check "написать себе нельзя" 400 "$(status POST "$API/direct" "{\"user_id\":\"$CHATTER_ID\"}" "$CHATTER")"
check "без общего сообщества личка не открывается" 403 \
  "$(status POST "$API/direct" "{\"user_id\":\"$CHATTER_ID\"}" "$OUTSIDER")"
check "переписка создаётся" 201 "$(status POST "$API/direct" "{\"user_id\":\"$CHATTER_ID\"}" "$OWNER")"
DM="$(jq -r .conversation.id "$TMP/out.json")"
check "повторно — та же переписка" "$DM" \
  "$(curl -sf -X POST "$API/direct" -H 'content-type: application/json' -H "authorization: Bearer $CHATTER" \
     -d "{\"user_id\":\"$(curl -sf "$API/users/me" -H "authorization: Bearer $OWNER" | jq -r .user.id)\"}" | jq -r .conversation.id)"
check "сообщение в личку" 201 "$(status POST "$API/messages" "{\"channel_id\":\"$DM\",\"content\":\"лично тебе\"}" "$OWNER")"
check "у собеседника непрочитанное" 1 \
  "$(curl -sf "$API/direct" -H "authorization: Bearer $CHATTER" | jq --arg id "$DM" '.conversations[]|select(.id==$id)|.unread')"
check "посторонний личку не читает" 403 "$(status GET "$API/messages?channel_id=$DM" '' "$OUTSIDER")"
check "посторонний в личку не пишет" 403 \
  "$(status POST "$API/messages" "{\"channel_id\":\"$DM\",\"content\":\"влез\"}" "$OUTSIDER")"
check "в личке закрепить может любой из двоих" 200 \
  "$(status PUT "$API/messages/$(jq -r .message.id <<< "$(curl -sf -X POST "$API/messages" -H 'content-type: application/json' \
     -H "authorization: Bearer $CHATTER" -d "{\"channel_id\":\"$DM\",\"content\":\"закрепи\"}")")/pin" '{"pinned":true}' "$CHATTER")"
check "файл в личку по channel_id" 201 \
  "$(curl -s -o "$TMP/out.json" -w '%{http_code}' -X POST "$API/attachments?channel_id=$DM&filename=pic.png" \
     -H "authorization: Bearer $OWNER" -H 'content-type: image/png' --data-binary @"$TMP/pic.png")"
check "личка не видна в каналах сообщества" 0 \
  "$(curl -sf "$API/communities/$CID" -H "authorization: Bearer $OWNER" | jq '[.channels[]|select(.type=="direct")]|length')"

echo '--- роли ---'
MOD="$(login "edge-mod-$S@example.com")"
MOD_ID="$(curl -sf "$API/users/me" -H "authorization: Bearer $MOD" | jq -r .user.id)"
curl -sf -X POST "$API/invites/$FRESH/join" -H 'content-type: application/json' \
  -H "authorization: Bearer $MOD" -d '{}' > /dev/null
OWNER_ID="$(curl -sf "$API/users/me" -H "authorization: Bearer $OWNER" | jq -r .user.id)"
check "участник не назначает модераторов" 403 \
  "$(status PATCH "$API/communities/$CID/members/$MOD_ID" '{"role":"moderator"}' "$CHATTER")"
check "выдуманная роль отклоняется" 400 \
  "$(status PATCH "$API/communities/$CID/members/$MOD_ID" '{"role":"admin"}' "$OWNER")"
check "владелец назначает модератора" 200 \
  "$(status PATCH "$API/communities/$CID/members/$MOD_ID" '{"role":"moderator"}' "$OWNER")"
check "владельца разжаловать нельзя" 404 \
  "$(status PATCH "$API/communities/$CID/members/$OWNER_ID" '{"role":"member"}' "$OWNER")"
check "модератор видит свои права" true \
  "$(curl -sf "$API/communities/$CID" -H "authorization: Bearer $MOD" \
     | jq '(.permissions|index("delete_any_message")) != null and (.permissions|index("manage_roles")) == null')"
check "модератор не назначает модераторов" 403 \
  "$(status PATCH "$API/communities/$CID/members/$CHATTER_ID" '{"role":"moderator"}' "$MOD")"
MEMBER_MSG="$(send "$CHATTER" "{\"channel_id\":\"$TEXT\",\"content\":\"спам\"}")"
check "модератор удаляет чужое сообщение" 204 "$(status DELETE "$API/messages/$MEMBER_MSG" '' "$MOD")"
check "модератор закрепляет" 200 "$(status PUT "$API/messages/$ROOT/pin" '{"pinned":false}' "$MOD")"
check "модератор создаёт канал" 201 \
  "$(status POST "$API/communities/$CID/channels" '{"name":"модерация","type":"text"}' "$MOD")"
check "модератор не переименовывает сообщество" 403 \
  "$(status PATCH "$API/communities/$CID" '{"name":"Моё"}' "$MOD")"
check "модератор не смотрит аналитику" 403 "$(status GET "$API/communities/$CID/analytics" '' "$MOD")"
check "модератор не исключает владельца" 403 "$(status DELETE "$API/communities/$CID/members/$OWNER_ID" '' "$MOD")"
check "участник по-прежнему не удаляет чужое" 403 \
  "$(status DELETE "$API/messages/$ROOT" '' "$CHATTER")"

echo '--- теги ---'
check "участник не создаёт теги" 403 \
  "$(status POST "$API/communities/$CID/tags" '{"name":"Дизайнер","color":"violet"}' "$CHATTER")"
check "модератор создаёт тег" 201 \
  "$(status POST "$API/communities/$CID/tags" '{"name":"Дизайнер","color":"violet"}' "$MOD")"
TAG1="$(jq -r .tag.id "$TMP/out.json")"
check "тег с тем же именем (другой регистр) — конфликт" 409 \
  "$(status POST "$API/communities/$CID/tags" '{"name":"дизайнер","color":"blue"}' "$OWNER")"
check "выдуманный цвет отклоняется" 400 \
  "$(status POST "$API/communities/$CID/tags" '{"name":"Красный","color":"#ff0000"}' "$OWNER")"
check "слишком длинное имя тега" 400 \
  "$(status POST "$API/communities/$CID/tags" "{\"name\":\"$(printf 'x%.0s' {1..30})\",\"color\":\"red\"}" "$OWNER")"
TAG2="$(curl -sf -X POST "$API/communities/$CID/tags" -H 'content-type: application/json' \
  -H "authorization: Bearer $OWNER" -d '{"name":"9 класс","color":"teal"}' | jq -r .tag.id)"
check "теги выставляются участнику" 200 \
  "$(status PUT "$API/communities/$CID/members/$CHATTER_ID/tags" "{\"tag_ids\":[\"$TAG1\",\"$TAG2\"]}" "$MOD")"
check "теги видны в составе" 2 \
  "$(curl -sf "$API/communities/$CID/members" -H "authorization: Bearer $CHATTER" \
     | jq --arg id "$CHATTER_ID" '.members[]|select(.id==$id)|.tags|length')"
check "участник сам себе теги не ставит" 403 \
  "$(status PUT "$API/communities/$CID/members/$CHATTER_ID/tags" '{"tag_ids":[]}' "$CHATTER")"
OTHER_COMMUNITY="$(curl -sf -X POST "$API/communities" -H 'content-type: application/json' \
  -H "authorization: Bearer $OUTSIDER" -d '{"name":"Чужое"}' | jq -r .community.id)"
FOREIGN_TAG="$(curl -sf -X POST "$API/communities/$OTHER_COMMUNITY/tags" -H 'content-type: application/json' \
  -H "authorization: Bearer $OUTSIDER" -d '{"name":"Чужой","color":"red"}' | jq -r .tag.id)"
check "тег чужого сообщества не выставить" 400 \
  "$(status PUT "$API/communities/$CID/members/$CHATTER_ID/tags" "{\"tag_ids\":[\"$FOREIGN_TAG\"]}" "$OWNER")"
check "не больше пяти тегов на человека" too_many_member_tags \
  "$(status PUT "$API/communities/$CID/members/$CHATTER_ID/tags" \
     "{\"tag_ids\":[\"$(cat /proc/sys/kernel/random/uuid)\",\"$(cat /proc/sys/kernel/random/uuid)\",\"$(cat /proc/sys/kernel/random/uuid)\",\"$(cat /proc/sys/kernel/random/uuid)\",\"$(cat /proc/sys/kernel/random/uuid)\",\"$(cat /proc/sys/kernel/random/uuid)\"]}" "$OWNER" > /dev/null; jq -r .error "$TMP/out.json")"
check "переименование тега" 200 \
  "$(status PATCH "$API/communities/$CID/tags/$TAG1" '{"name":"Дизайнер интерфейсов"}' "$OWNER")"
check "удаление тега снимает его с участников" 1 \
  "$(status DELETE "$API/communities/$CID/tags/$TAG1" '' "$OWNER" > /dev/null; \
     curl -sf "$API/communities/$CID/members" -H "authorization: Bearer $OWNER" \
     | jq --arg id "$CHATTER_ID" '.members[]|select(.id==$id)|.tags|length')"
check "модератор исключает участника" 200 "$(status DELETE "$API/communities/$CID/members/$CHATTER_ID" '' "$MOD")"
check "с исключённого теги сняты" 0 \
  "$(curl -sf "$API/communities/$CID/tags" -H "authorization: Bearer $OWNER" | jq '[.tags[].member_count]|add')"

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
