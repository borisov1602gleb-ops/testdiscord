# Платформа тематических сообществ — MVP backend

Backend и инфраструктура MVP по спецификации проекта: сообщества с текстовыми и
голосовыми каналами, вход по коду на email, подключение к звонку по инвайт-ссылке
без регистрации и логирование продуктовых событий в аналитический слой Bronze.

## Стек

| Компонент | Технология |
|---|---|
| Backend | Node.js 20+ / Express |
| База данных | PostgreSQL 16 |
| Реалтайм-чат | Socket.IO (WebSocket) |
| Звонки — SFU | LiveKit (self-hosted, dev-режим) |
| Звонки — TURN/STUN | coturn (self-hosted) |
| Email | SMTP-заглушка (код печатается в лог backend) |
| Оркестрация | docker-compose |

## Запуск

```bash
docker compose up --build
```

Поднимаются `postgres` (схема из `db/schema.sql` применяется при первом старте),
`backend` на порту 3000, `livekit` в dev-режиме (ключи `devkey`/`secret`) и `coturn`.

Проверка: `curl http://localhost:3000/health`

### Локальный запуск без Docker

```bash
createdb community && psql -d community -f db/schema.sql
cd backend && npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5432/community \
EXPOSE_DEV_CODE=true npm start
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | Порт backend |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/community` | Подключение к PostgreSQL |
| `JWT_SECRET` | `dev-secret-change-me` | Подпись токенов — **обязательно заменить в проде** |
| `LOGIN_CODE_TTL_SEC` | `600` | Срок жизни кода входа |
| `LOGIN_CODE_COOLDOWN_SEC` | `60` | Rate-limit повторной отправки кода на один email |
| `EXPOSE_DEV_CODE` | `false` (в compose — `true`) | Возврат кода входа в HTTP-ответе. Только для локальной разработки и e2e-прогонов, пока SMTP — заглушка. **В проде должно быть `false`** |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `ws://localhost:7880` / `devkey` / `secret` | Доступ к LiveKit |

## API

Авторизация — `Authorization: Bearer <token>` из `/auth/verify-code`.

| Метод | Путь | Авторизация | Логика |
|---|---|---|---|
| POST | `/auth/send-code` | — | Генерирует код, пишет в `login_codes`, rate-limit 60 сек/email (429 + `Retry-After`) |
| POST | `/auth/verify-code` | — | Проверяет код, создаёт/находит пользователя, привязывает `anonymous_id`, выдаёт токен |
| POST | `/communities` | да | Создаёт сообщество, владельца и два канала (text + voice) |
| GET | `/communities/:id` | да, участник | Сообщество и список каналов |
| POST | `/invites` | да, участник | Создаёт инвайт (`expires_at`, `max_uses` — опционально) |
| GET | `/invites/:id` | — | Превью сообщества для гостя + событие `invite_link_opened` |
| POST | `/invites/:id/join` | да | Вступление в сообщество, инкремент `use_count`, событие `community_joined` |
| POST | `/calls` | да (участник) или гость с `invite_id` | Создаёт звонковую сессию в голосовом канале (одна активная на канал) |
| POST | `/calls/:id/join` | опционально | Добавляет в `call_participants`, выдаёт токен LiveKit, событие `call_joined` с `join_status` |
| POST | `/calls/:id/leave` | опционально | Считает `duration_sec`, событие `call_participated` (только для `user_id`) |
| POST | `/messages` | да, участник | Создаёт сообщение, рассылает по WebSocket, событие `message_sent` |
| GET | `/messages?channel_id=` | да, участник | История сообщений |

Гость без регистрации допускается в звонок только по действующему инвайту того
сообщества, которому принадлежит канал — иначе подключение отклоняется, а в
`events_bronze` пишется `call_joined` с `join_status: failed`.

### WebSocket

Подключение: `io('http://localhost:3000', { auth: { token } })` — без валидного
токена соединение отклоняется. События: `join_channel` / `leave_channel`
(с `channel_id`, проверяется членство в сообществе), входящее `message`.

## Аналитика

Все шесть продуктовых событий пишутся в `events_bronze` через общую функцию
`logEvent(type, payload, source)` (`backend/src/lib/events.js`): она генерирует
`event_id` и `timestamp` и сохраняет payload без валидации — по принципу
Bronze-слоя. Silver/Gold ETL в объём этого этапа не входит.

События: `invite_link_opened`, `call_joined`, `registration_completed`,
`community_joined`, `message_sent`, `call_participated`.

Сбой записи события логируется, но не ломает пользовательский сценарий.

## Тесты

Полный сценарий критерия готовности (создание сообщества → инвайт → открытие
гостем → звонок без регистрации → регистрация → вступление в сообщество →
выход из звонка с `duration_sec` → сообщение → проверка всех 6 типов событий):

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres ./scripts/e2e-test.sh
```

Проверка реалтайм-доставки по WebSocket:

```bash
cd backend && node scripts/ws-test.mjs
```

Оба скрипта требуют запущенный backend с `EXPOSE_DEV_CODE=true`.

## Структура

```
backend/src/
  index.js            точка входа: Express + Socket.IO
  config.js           конфигурация из переменных окружения
  db.js               пул подключений, транзакции
  lib/events.js       logEvent — запись в events_bronze
  lib/livekit.js      выдача токенов доступа к комнате
  lib/mailer.js       SMTP-заглушка
  lib/realtime.js     WebSocket-слой
  lib/access.js       проверки членства в сообществе
  middleware/auth.js  JWT
  routes/             auth, communities, invites, calls, messages
db/schema.sql         схема БД
coturn/               конфигурация TURN-сервера
scripts/e2e-test.sh   end-to-end сценарий
```

## Что не входит в MVP

Видео и демонстрация экрана, кастомные роли, множественные каналы, стриминг,
модерация, push-уведомления, мобильное приложение, Silver/Gold ETL.
