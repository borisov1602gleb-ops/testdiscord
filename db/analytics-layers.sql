-- Аналитические слои Silver и Gold (раздел 6.3 спецификации).
--
-- Bronze (events_bronze) — сырой лог: пишем как пришло, ничего не проверяем.
-- Silver (events_silver) — очищенный лог: типы разобраны по колонкам, дубли
--   убраны по event_id, гость склеен с пользователем в одного человека,
--   мусор не выброшен, а отложен в events_silver_rejected с причиной.
-- Gold (gold_*) — готовые витрины под конкретные вопросы: воронка,
--   активность по дням, вовлечённость по неделям, жизненный цикл участника,
--   длительности звонков. Экран аналитики читает только их.
--
-- Файл идемпотентный: backend применяет его при каждом старте, повторный
-- запуск ничего не ломает. Вручную: psql -d community -f db/analytics-layers.sql

-- ===== вспомогательные функции безопасного приведения типов =====
-- В Bronze payload не валидируется, поэтому в любом поле может оказаться
-- что угодно. Эти функции возвращают NULL вместо ошибки, а решение
-- «принять или отклонить событие» принимается уже по NULL.

CREATE OR REPLACE FUNCTION silver_uuid(value TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN value::uuid
  END;
$$;

CREATE OR REPLACE FUNCTION silver_int(value TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value ~ '^-?[0-9]{1,9}$' THEN value::integer END;
$$;

CREATE OR REPLACE FUNCTION silver_ts(value TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Что считается «активным действием» человека. Открытие ссылки и неудачная
-- попытка подключения сюда не входят: иначе в знаменатель вовлечённости
-- попадут случайные заходы, которые ничем не закончились.
CREATE OR REPLACE FUNCTION gold_is_active_action(kind TEXT, status TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT kind IN ('message_sent', 'call_participated', 'community_joined')
      OR (kind = 'call_joined' AND status = 'success');
$$;

-- ===== SILVER =====

-- Склейка личностей: до регистрации человек живёт как anonymous_id,
-- после — как user_id. Без этой таблицы один и тот же человек считался бы
-- в воронке дважды.
CREATE TABLE IF NOT EXISTS identity_map (
  anonymous_id TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events_silver (
  event_id     UUID PRIMARY KEY,
  event_type   TEXT NOT NULL,
  -- Когда действие произошло (из payload) и когда его получил сервер.
  -- Обычно совпадают, но считать надо по первому.
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL,
  -- Один человек = один person_id: 'user:<uuid>' либо 'anon:<id>', пока он
  -- не зарегистрировался.
  person_id    TEXT NOT NULL,
  user_id      UUID,
  anonymous_id TEXT,
  device_id    TEXT,
  community_id UUID,
  channel_id   UUID,
  call_id      UUID,
  invite_id    UUID,
  message_id   UUID,
  join_status  TEXT,
  duration_sec INTEGER,
  source       TEXT,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Карантин: событие, не прошедшее проверку, не удаляется, а откладывается
-- с причиной. Так видно, что именно ломается, и ничего не теряется молча.
CREATE TABLE IF NOT EXISTS events_silver_rejected (
  event_id    UUID PRIMARY KEY,
  event_type  TEXT,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  reason      TEXT NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отметка прогресса ETL: до какого события слой уже прочитан.
CREATE TABLE IF NOT EXISTS etl_state (
  layer            TEXT PRIMARY KEY,
  last_received_at TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ,
  rows_loaded      BIGINT NOT NULL DEFAULT 0,
  last_error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_silver_community_time
  ON events_silver (community_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_silver_type_time
  ON events_silver (event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_silver_person
  ON events_silver (person_id);
CREATE INDEX IF NOT EXISTS idx_silver_anonymous
  ON events_silver (anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bronze_received
  ON events_bronze (received_at);

-- ===== GOLD =====
-- Витрины пересобираются целиком на каждом прогоне: данных мало, а полная
-- пересборка исключает расхождения после задним числом приехавших событий
-- и после склейки гостя с пользователем.

-- Активность сообщества по дням.
CREATE TABLE IF NOT EXISTS gold_community_daily (
  community_id       UUID NOT NULL,
  day                DATE NOT NULL,
  messages           INTEGER NOT NULL DEFAULT 0,
  call_participations INTEGER NOT NULL DEFAULT 0,
  call_seconds       INTEGER NOT NULL DEFAULT 0,
  invite_opens       INTEGER NOT NULL DEFAULT 0,
  join_attempts      INTEGER NOT NULL DEFAULT 0,
  join_failures      INTEGER NOT NULL DEFAULT 0,
  new_members        INTEGER NOT NULL DEFAULT 0,
  active_people      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, day)
);

-- Вовлечённость по неделям (WECU): активные — кто сделал хоть что-то,
-- вовлечённые — кто перешагнул порог из спецификации.
CREATE TABLE IF NOT EXISTS gold_community_weekly (
  community_id   UUID NOT NULL,
  week_start     DATE NOT NULL,
  active_people  INTEGER NOT NULL DEFAULT 0,
  engaged_people INTEGER NOT NULL DEFAULT 0,
  messages       INTEGER NOT NULL DEFAULT 0,
  call_seconds   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, week_start)
);

-- Воронка приглашения — вложенная и по людям: каждый следующий шаг
-- считается только среди тех, кто прошёл предыдущий.
CREATE TABLE IF NOT EXISTS gold_invite_funnel (
  community_id     UUID PRIMARY KEY,
  opened           INTEGER NOT NULL DEFAULT 0,
  joined_call      INTEGER NOT NULL DEFAULT 0,
  registered       INTEGER NOT NULL DEFAULT 0,
  joined_community INTEGER NOT NULL DEFAULT 0,
  -- Для сравнения: сколько всего людей вступило, включая пришедших мимо
  -- воронки (например, владелец или приглашённый другим способом).
  joined_total     INTEGER NOT NULL DEFAULT 0
);

-- Жизненный цикл участника: из него считаются активация и возврат.
-- Строки берутся из community_members (это источник правды о составе),
-- а действия подтягиваются из Silver. Владелец помечен отдельно: он не
-- «вступал» и в активации участвовать не должен.
CREATE TABLE IF NOT EXISTS gold_member_lifecycle (
  community_id   UUID NOT NULL,
  person_id      TEXT NOT NULL,
  user_id        UUID,
  is_owner       BOOLEAN NOT NULL DEFAULT false,
  joined_at      TIMESTAMPTZ NOT NULL,
  first_action_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ,
  actions        INTEGER NOT NULL DEFAULT 0,
  activated_24h  BOOLEAN NOT NULL DEFAULT false,
  returned_d7    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (community_id, person_id)
);

-- Длительности звонков: среднее, медиана и максимум считаются один раз
-- при сборке витрины, а не на каждом открытии экрана.
CREATE TABLE IF NOT EXISTS gold_call_stats (
  community_id   UUID PRIMARY KEY,
  participations INTEGER NOT NULL DEFAULT 0,
  total_sec      INTEGER NOT NULL DEFAULT 0,
  avg_sec        INTEGER NOT NULL DEFAULT 0,
  median_sec     INTEGER NOT NULL DEFAULT 0,
  longest_sec    INTEGER NOT NULL DEFAULT 0
);
