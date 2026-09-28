-- Возможности чата: правка и удаление сообщений, ответы, реакции,
-- упоминания, вложения и отметки прочтения.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== вложения =====
-- Сам файл лежит на диске под случайным именем, в базе — только описание.
-- Имя, которое прислал пользователь, в путь не попадает никогда: иначе
-- можно было бы записать файл куда угодно.
CREATE TABLE IF NOT EXISTS attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  uploader_id  UUID NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== сообщения: правка, удаление, ответ, вложение =====
-- Удаление мягкое: строка остаётся, чтобы не рассыпались ответы на неё
-- и не врала аналитика, а текст стирается.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_id UUID REFERENCES attachments(id) ON DELETE SET NULL;

-- ===== реакции =====
-- Одна реакция одного вида от одного человека: повторное нажатие снимает её.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- ===== упоминания =====
-- Храним явно, кого упомянули: по тексту это не восстановить надёжно —
-- имена повторяются и меняются.
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

-- ===== прочтение =====
-- Одна строка на человека и канал: до какого момента он дочитал.
-- Из неё считаются и непрочитанные, и «кто просмотрел» — как в Telegram:
-- сообщение прочитано тем, у кого отметка не раньше его отправки.
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions (user_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;
