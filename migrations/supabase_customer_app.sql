-- Customer app (Oct 2026): customers log in with their phone number and chat with the businesses that know them
CREATE TABLE IF NOT EXISTS ca_account (
  id                   BIGSERIAL PRIMARY KEY,
  phone                TEXT NOT NULL,
  name                 TEXT NULL,
  token_version        INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_account_phone ON ca_account (phone);

-- login codes: hashed, 10 minutes, max 5 tries, one send a minute, 6 an hour
CREATE TABLE IF NOT EXISTS ca_login_code (
  phone                TEXT PRIMARY KEY,
  code_hash            TEXT NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  attempts             INT NOT NULL DEFAULT 0,
  last_sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hour_started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sends_this_hour      INT NOT NULL DEFAULT 1
);

-- per business: the app is switched on by the owner
CREATE TABLE IF NOT EXISTS ca_settings (
  company_id           BIGINT PRIMARY KEY,
  enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  welcome_text         TEXT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- when the customer last read their chat with a business (for unread counts)
CREATE TABLE IF NOT EXISTS ca_chat_state (
  channel_user_id      BIGINT PRIMARY KEY,
  account_id           BIGINT NOT NULL,
  last_read_at         TIMESTAMPTZ NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ca_chat_state_account ON ca_chat_state (account_id);

-- login SMS sent per day (a cap against SMS abuse)
CREATE TABLE IF NOT EXISTS ca_sms_day (
  day                  DATE PRIMARY KEY,
  sent                 INT NOT NULL DEFAULT 0
);
