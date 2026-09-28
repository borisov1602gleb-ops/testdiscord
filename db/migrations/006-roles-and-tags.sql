-- Роль модератора и теги участников.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== роли =====
-- Между владельцем и участником появляется модератор: помогает владельцу
-- следить за порядком, но не распоряжается сообществом.
ALTER TABLE community_members DROP CONSTRAINT IF EXISTS community_members_role_check;
ALTER TABLE community_members ADD CONSTRAINT community_members_role_check
  CHECK (role IN ('owner', 'moderator', 'member'));

-- ===== теги =====
-- Тег — подпись участника внутри сообщества: «Дизайнер», «9 класс»,
-- «Капитан». На права не влияет, помогает понять, кто есть кто.
-- Цвет — из фиксированной палитры: произвольный цвет пришлось бы
-- проверять на читаемость в тёмной теме.
CREATE TABLE IF NOT EXISTS community_tags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL CHECK (color IN ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink')),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Два тега «Дизайнер» и «дизайнер» в одном сообществе — путаница.
CREATE UNIQUE INDEX IF NOT EXISTS uq_community_tags_name
  ON community_tags (community_id, lower(name));

CREATE TABLE IF NOT EXISTS member_tags (
  tag_id      UUID NOT NULL REFERENCES community_tags(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_tags_user ON member_tags (user_id);
