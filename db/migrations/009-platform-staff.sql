-- Команда платформы: роли поверх сообществ, жалобы в службу платформы,
-- меры (санкции), обжалования, журнал действий и настройки платформы.
--
-- Роли сообществ (владелец, модератор, участник) действуют внутри одного
-- сообщества. Роль платформы — на всей платформе сразу: модератор,
-- администратор, суперадминистратор. Обычный человек — 'user'.

ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_platform_role_check;
ALTER TABLE users ADD CONSTRAINT users_platform_role_check
  CHECK (platform_role IN ('user', 'moderator', 'admin', 'superadmin'));
CREATE INDEX IF NOT EXISTS idx_users_platform_staff ON users (platform_role) WHERE platform_role <> 'user';

-- ===== жалобы в службу платформы =====
-- На сообщение (в том числе в личке), на человека и на сообщество целиком.
-- Модераторы сообщества тоже могут передать свою жалобу сюда.
CREATE TABLE IF NOT EXISTS platform_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type    TEXT NOT NULL CHECK (target_type IN ('message', 'user', 'community')),
  message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- На кого жалоба: автор сообщения, сам человек или владелец сообщества.
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  community_id   UUID REFERENCES communities(id) ON DELETE SET NULL,
  reporter_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'community')),
  reason         TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'illegal', 'other')),
  comment        TEXT,
  -- open — ждёт разбора; escalated — модератор передал администраторам;
  -- resolved — приняты меры; dismissed — нарушения нет.
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'escalated', 'resolved', 'dismissed')),
  escalated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  escalated_at   TIMESTAMPTZ,
  handled_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at     TIMESTAMPTZ,
  decision       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_reports_status ON platform_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_reports_target_user ON platform_reports (target_user_id);
-- Повторная жалоба того же человека на то же самое, пока первая не
-- разобрана, ничего не добавляет.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_reports_open_message
  ON platform_reports (reporter_id, message_id)
  WHERE message_id IS NOT NULL AND target_type = 'message' AND status IN ('open', 'escalated');
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_reports_open_user
  ON platform_reports (reporter_id, target_user_id)
  WHERE target_type = 'user' AND status IN ('open', 'escalated');
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_reports_open_community
  ON platform_reports (reporter_id, community_id)
  WHERE target_type = 'community' AND status IN ('open', 'escalated');

-- ===== меры =====
-- Одна строка — одно решение команды платформы, которое можно обжаловать
-- или снять: меры против человека (предупреждение, заглушение, временная
-- и вечная блокировка), удаление сообщения и меры против сообщества.
-- Старые меры не удаляются: у человека видна вся история.
CREATE TABLE IF NOT EXISTS platform_sanctions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Кого касается: сам человек, автор сообщения или владелец сообщества.
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'warning', 'mute', 'suspend', 'ban',
                   'message_removed',
                   'community_invites_hidden', 'community_frozen', 'community_deleted')),
  message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  community_id   UUID REFERENCES communities(id) ON DELETE SET NULL,
  report_id      UUID REFERENCES platform_reports(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL,
  issued_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_by_role TEXT NOT NULL,
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Когда кончается. NULL — бессрочно (вечная блокировка) или пока не
  -- снимут (меры против сообщества, удаление сообщения).
  ends_at        TIMESTAMPTZ,
  -- Удаление по требованию госоргана: обжаловать и вернуть нельзя.
  final          BOOLEAN NOT NULL DEFAULT false,
  -- Человек увидел предупреждение или уведомление о мере.
  seen_at        TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_sanctions_user ON platform_sanctions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_sanctions_active
  ON platform_sanctions (user_id, kind) WHERE revoked_at IS NULL;

-- ===== обжалования =====
-- Одно обжалование на одну меру: отказали — повторно подать нельзя.
CREATE TABLE IF NOT EXISTS platform_appeals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sanction_id      UUID NOT NULL UNIQUE REFERENCES platform_sanctions(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewer_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  response         TEXT,
  response_seen_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_appeals_status ON platform_appeals (status, created_at);

-- ===== состояние сообщества =====
-- active — обычное; invites_hidden — новые люди не вступают; frozen — всё
-- только для чтения; deleted — недоступно никому, через 30 дней содержимое
-- стирается (purged_at).
ALTER TABLE communities ADD COLUMN IF NOT EXISTS platform_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_platform_status_check;
ALTER TABLE communities ADD CONSTRAINT communities_platform_status_check
  CHECK (platform_status IN ('active', 'invites_hidden', 'frozen', 'deleted'));
ALTER TABLE communities ADD COLUMN IF NOT EXISTS platform_status_at TIMESTAMPTZ;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- ===== сообщения, удалённые платформой =====
-- Текст не стирается сразу, а скрывается: 30 дней его можно вернуть, если
-- обжалование удовлетворят. Потом стирается (platform_purged_at).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform_removed_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform_purged_at TIMESTAMPTZ;

-- ===== журнал действий команды =====
-- Кто, что, когда, над кем и почему. Только добавление: изменить или
-- удалить запись запрещает сама база, даже если в коде будет ошибка.
-- Ссылок на users нет намеренно: удаление человека не должно менять журнал.
CREATE TABLE IF NOT EXISTS staff_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID,
  actor_email TEXT,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  reason      TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_audit_actor ON staff_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_audit_created ON staff_audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION staff_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit_log: записи журнала нельзя менять или удалять';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_audit_log_no_change ON staff_audit_log;
CREATE TRIGGER staff_audit_log_no_change
  BEFORE UPDATE OR DELETE ON staff_audit_log
  FOR EACH ROW EXECUTE FUNCTION staff_audit_log_append_only();
DROP TRIGGER IF EXISTS staff_audit_log_no_truncate ON staff_audit_log;
CREATE TRIGGER staff_audit_log_no_truncate
  BEFORE TRUNCATE ON staff_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION staff_audit_log_append_only();

-- ===== настройки платформы =====
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES
  ('registration_open', 'true'::jsonb),
  ('max_communities_per_user', '20'::jsonb),
  ('max_invites_per_day', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Жалобу внутри сообщества модераторы могут передать в службу платформы.
ALTER TABLE message_reports DROP CONSTRAINT IF EXISTS message_reports_status_check;
ALTER TABLE message_reports ADD CONSTRAINT message_reports_status_check
  CHECK (status IN ('open', 'resolved', 'dismissed', 'escalated'));
