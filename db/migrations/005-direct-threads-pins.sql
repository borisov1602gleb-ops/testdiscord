-- Личные сообщения, треды, закреплённые сообщения и поиск.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== личные сообщения =====
-- Личная переписка — это канал особого типа 'direct' без сообщества.
-- Так все возможности чата (правка, реакции, файлы, «кто просмотрел»)
-- работают в ней без отдельного кода.
ALTER TABLE channels ALTER COLUMN community_id DROP NOT NULL;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
  CHECK (type IN ('text', 'voice', 'direct'));
-- У обычного канала сообщество есть всегда, у личного — никогда.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_community_matches_type;
ALTER TABLE channels ADD CONSTRAINT channels_community_matches_type
  CHECK ((type = 'direct') = (community_id IS NULL));
-- Ключ пары собеседников («меньший id:больший id»): одна переписка на пару,
-- даже если оба нажали «Написать» одновременно.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS direct_key TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS direct_members (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_direct_members_user ON direct_members (user_id);

-- Вложение теперь привязывается к каналу: у личной переписки сообщества нет.
ALTER TABLE attachments ALTER COLUMN community_id DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

-- ===== треды =====
-- Сообщение треда ссылается на корневое сообщение и в общую ленту не
-- попадает. Вложенных тредов нет: корень всегда из общей ленты.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at) WHERE thread_id IS NOT NULL;

-- ===== закреплённые =====
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- ===== лента и поиск =====
-- Лента канала читается «последние N до такого-то»: без индекса по
-- (канал, время) каждая страница перебирала бы весь канал.
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel_id, created_at, id);
