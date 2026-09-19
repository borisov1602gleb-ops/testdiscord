-- Схема БД продукта (раздел 7 спецификации).
-- Применяется автоматически при первом старте контейнера postgres
-- (монтируется в /docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL UNIQUE,
  registration_source TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE communities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  owner_id   UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ,
  max_uses    INTEGER,
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE community_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  invite_id    UUID REFERENCES invites(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, user_id)
);

CREATE TABLE messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);

CREATE TABLE call_participants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id),
  anonymous_id TEXT,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at      TIMESTAMPTZ,
  duration_sec INTEGER,
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL)
);

CREATE TABLE login_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Аналитический лог, слой BRONZE (раздел 6.3). Без валидации содержимого.
CREATE TABLE events_bronze (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT
);

CREATE INDEX idx_messages_channel_created ON messages (channel_id, created_at);
CREATE INDEX idx_call_participants_call ON call_participants (call_id);
CREATE INDEX idx_call_participants_anonymous ON call_participants (anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX idx_community_members_user ON community_members (user_id);
CREATE INDEX idx_login_codes_email_created ON login_codes (email, created_at DESC);
CREATE INDEX idx_events_bronze_type ON events_bronze (event_type);
CREATE INDEX idx_channels_community ON channels (community_id);
CREATE INDEX idx_invites_community ON invites (community_id);
