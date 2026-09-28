-- Бан, жалобы, упоминание по тегу, опросы, голосовые сообщения и аватарки.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== бан =====
-- Исключённый по-прежнему может вернуться по ссылке; забаненный — нет,
-- пока его не разбанят.
CREATE TABLE IF NOT EXISTS community_bans (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

-- ===== жалобы =====
CREATE TABLE IF NOT EXISTS message_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  reporter_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'other')),
  comment      TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Один человек — одна открытая жалоба на сообщение: повторное нажатие
-- не должно раздувать счётчик.
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_reports_open
  ON message_reports (message_id, reporter_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_message_reports_queue
  ON message_reports (community_id, status, created_at);

-- ===== упоминание по тегу =====
-- Кого именно это затронуло, лежит в message_mentions (тег разворачивается
-- в людей при отправке). Здесь — какой тег упомянули, чтобы подсветить
-- «@Дизайнер» в тексте.
CREATE TABLE IF NOT EXISTS message_tag_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES community_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, tag_id)
);

-- ===== опросы =====
CREATE TABLE IF NOT EXISTS polls (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  multiple   BOOLEAN NOT NULL DEFAULT false,
  closed_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id  UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text     TEXT NOT NULL,
  UNIQUE (poll_id, position)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id);

-- ===== голосовые сообщения =====
-- Длительность присылает браузер: в записи MediaRecorder её часто нет,
-- а показывать «0:37» у сообщения хочется сразу, без загрузки файла.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- ===== аватарки =====
-- Картинка хранится как обычное вложение; у человека и у сообщества —
-- ссылка на него.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id UUID REFERENCES attachments(id) ON DELETE SET NULL;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS avatar_id UUID REFERENCES attachments(id) ON DELETE SET NULL;
