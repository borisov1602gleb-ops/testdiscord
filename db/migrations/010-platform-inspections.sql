-- Проверка сообщества службой платформы: администратор по жалобе
-- открывает сообщество на час и читает его открытые каналы — без права
-- писать. Закрытые каналы и личная переписка в проверку не входят.
-- Сообщество о проверке не уведомляется; каждая проверка — в журнале.
CREATE TABLE IF NOT EXISTS platform_inspections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  report_id    UUID REFERENCES platform_reports(id) ON DELETE SET NULL,
  reason       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_inspections_active
  ON platform_inspections (staff_id, community_id, expires_at);
