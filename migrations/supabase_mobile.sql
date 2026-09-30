-- Agent Metra mobile app: push devices (Firebase Cloud Messaging). Runs at startup. Safe to run many times.
CREATE TABLE IF NOT EXISTS push_device (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  company_id  BIGINT NULL,
  token       VARCHAR(512) NOT NULL UNIQUE,
  platform    VARCHAR(10) NOT NULL DEFAULT 'android',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_device_user ON push_device (user_id);
-- remembers what was already pushed
CREATE TABLE IF NOT EXISTS push_cursor (
  name        VARCHAR(40) PRIMARY KEY,
  last_id     BIGINT NOT NULL DEFAULT 0
);
