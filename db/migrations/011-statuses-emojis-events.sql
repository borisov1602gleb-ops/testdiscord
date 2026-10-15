-- Статусы людей, свои эмодзи и стикеры сообществ, события и календарь.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== статусы =====
-- Режим присутствия, который человек выбрал сам: online — обычный (и
-- «отошёл» ставится сам после 10 минут без активности), away — «отошёл»
-- вручную, dnd — «не беспокоить», invisible — для остальных «не в сети».
-- Подпись — до 80 символов с эмодзи и необязательным сроком.
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_mode TEXT NOT NULL DEFAULT 'online';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_presence_mode_check;
ALTER TABLE users ADD CONSTRAINT users_presence_mode_check
  CHECK (presence_mode IN ('online', 'away', 'dnd', 'invisible'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_expires_at TIMESTAMPTZ;

-- ===== эмодзи и стикеры =====
-- Загружают владелец и модераторы. Удаление мягкое: старые сообщения со
-- стикером показывают «стикер удалён», а не ломаются. Имя уникально в
-- сообществе среди живых эмодзи (и отдельно — среди стикеров).
CREATE TABLE IF NOT EXISTS community_emojis (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('emoji', 'sticker')),
  name          TEXT NOT NULL,
  attachment_id UUID NOT NULL REFERENCES attachments(id),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  -- Кто удалил: модерация сообщества или служба платформы.
  deleted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_by_platform BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_emojis_name
  ON community_emojis (community_id, kind, lower(name)) WHERE deleted_at IS NULL;

-- Стикер — отдельное сообщение без текста.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker_id UUID REFERENCES community_emojis(id);

-- ===== события =====
-- Событие сообщества: где (голосовой канал или «вне платформы»), когда,
-- повторяется ли каждую неделю. Повторяющееся событие — цепочка строк с
-- общим series_id: следующая создаётся, когда начинается текущая, так у
-- каждой встречи свои ответы «пойду / не пойду» и своя явка.
CREATE TABLE IF NOT EXISTS community_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id   UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  series_id      UUID NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ,
  channel_id     UUID REFERENCES channels(id) ON DELETE SET NULL,
  location_text  TEXT,
  repeat_weekly  BOOLEAN NOT NULL DEFAULT false,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  -- Когда разосланы напоминания: за 15 минут и в момент начала.
  reminded_soon_at  TIMESTAMPTZ,
  reminded_start_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_community_events_upcoming
  ON community_events (community_id, starts_at) WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id   UUID NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer     TEXT NOT NULL CHECK (answer IN ('going', 'maybe', 'no')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
