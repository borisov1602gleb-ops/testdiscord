-- Профиль пользователя: имя для показа другим и скрытие почты.
-- Для уже работающей базы: psql -U postgres -d community -f db/migrations/001-profile.sql
-- Новые базы получают эти поля сразу из db/schema.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_email BOOLEAN NOT NULL DEFAULT false;
