-- Автовыход из звонка, настройки уведомлений, закрытые каналы и каналы
-- «только для чтения», совместная доска в голосовом канале.
--
-- Файл идемпотентный, как и остальные миграции: применяется при каждом
-- старте backend и ничего не ломает при повторе.

-- ===== автовыход из звонка =====
-- Вкладка звонка раз в несколько секунд подтверждает, что человек на
-- месте. Кто замолчал (закрыл вкладку, пропала связь), того сервер
-- выводит из звонка сам — длительность считается до последнего сигнала.
ALTER TABLE call_participants ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- ===== уведомления =====
-- Уровень уведомлений для канала или сообщества целиком: все сообщения,
-- только упоминания или ничего. Нет строки — действует значение по
-- умолчанию. Хранится на сервере, чтобы совпадать на всех устройствах.
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'community')),
  target_id   UUID NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'none')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

-- ===== закрытые каналы и «только для чтения» =====
-- Закрытый канал видят владелец, модераторы и те, у кого есть хотя бы
-- один из разрешённых тегов. В канал «только для чтения» пишут владелец
-- и модераторы — остальные читают и ставят реакции.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS channel_allowed_tags (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES community_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, tag_id)
);

-- ===== доска =====
-- Одна доска на голосовой канал: переживает звонки, к ней можно вернуться.
CREATE TABLE IF NOT EXISTS boards (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Элемент доски: линия, фигура, стрелка, текст, стикер или кадр демонстрации экрана. id придумывает
-- браузер — так рисунок появляется у автора сразу, без ожидания сервера.
-- Геометрия и оформление лежат в data; сервер проверяет их перед записью.
CREATE TABLE IF NOT EXISTS board_elements (
  board_id    UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  id          UUID NOT NULL,
  type        TEXT NOT NULL,
  data        JSONB NOT NULL,
  z           DOUBLE PRECISION NOT NULL,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, id)
);

-- Список типов держим отдельным ограничением: при новом типе его проще
-- пересоздать, чем менять таблицу.
ALTER TABLE board_elements DROP CONSTRAINT IF EXISTS board_elements_type_check;
ALTER TABLE board_elements ADD CONSTRAINT board_elements_type_check
  CHECK (type IN ('path', 'rect', 'ellipse', 'arrow', 'text', 'sticky', 'image'));
