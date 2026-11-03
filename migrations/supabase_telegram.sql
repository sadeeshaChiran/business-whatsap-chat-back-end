-- Telegram (Oct 2026): one Telegram bot per company, chats in the inbox, announcements to a channel and to bot subscribers
CREATE TABLE IF NOT EXISTS telegram_connection (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  bot_id               TEXT NOT NULL,
  bot_username         TEXT NULL,
  bot_name             TEXT NULL,
  bot_token            TEXT NOT NULL,
  webhook_secret       TEXT NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'CONNECTED',
  last_error           TEXT NULL,
  last_event_at        TIMESTAMPTZ NULL,
  welcome_text         TEXT NULL,
  channel_chat_id      TEXT NULL,
  channel_title        TEXT NULL,
  channel_username     TEXT NULL,
  connected_by         BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_connection_bot ON telegram_connection (bot_id);
CREATE INDEX IF NOT EXISTS idx_telegram_connection_company ON telegram_connection (company_id);

-- customers who blocked the bot (Telegram refuses messages to them)
CREATE TABLE IF NOT EXISTS telegram_subscriber_state (
  channel_user_id      BIGINT PRIMARY KEY,
  blocked_at           TIMESTAMPTZ NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_announcement (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  text                 TEXT NOT NULL,
  media_url            TEXT NULL,
  to_channel           BOOLEAN NOT NULL DEFAULT FALSE,
  to_subscribers       BOOLEAN NOT NULL DEFAULT FALSE,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  status               VARCHAR(20) NOT NULL DEFAULT 'sending',
  total                INT NOT NULL DEFAULT 0,
  sent                 INT NOT NULL DEFAULT 0,
  failed               INT NOT NULL DEFAULT 0,
  channel_ok           BOOLEAN NULL,
  last_error           TEXT NULL,
  created_by           BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at          TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_announcement_company ON telegram_announcement (company_id, created_at DESC);

-- packages that switch Instagram off also switch Telegram off (a package without the key allows it)
UPDATE platform_package SET limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object('telegram', false)
 WHERE COALESCE(limits, '{}'::jsonb) ->> 'instagram' = 'false' AND NOT (COALESCE(limits, '{}'::jsonb) ? 'telegram');
