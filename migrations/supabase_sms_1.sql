-- SMS (Oct 2026): each business sends SMS with its own Notify.lk account (own sender name, own credit).
-- the business SMS account
CREATE TABLE IF NOT EXISTS sms_account (
  company_id     BIGINT PRIMARY KEY,
  provider       VARCHAR(20) NOT NULL DEFAULT 'notifylk',
  user_id        VARCHAR(60) NOT NULL,
  api_key        TEXT NOT NULL,
  sender_id      VARCHAR(20) NOT NULL,
  footer         VARCHAR(80) NULL,
  balance        NUMERIC(14,2) NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'ok',
  last_error     TEXT NULL,
  connected_by   BIGINT NULL,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at     TIMESTAMPTZ NULL
);
-- an SMS campaign (offers, reminders, notices)
CREATE TABLE IF NOT EXISTS sms_campaign (
  id            BIGSERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  name          VARCHAR(120) NOT NULL,
  text          TEXT NOT NULL,
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(12) NOT NULL DEFAULT 'sending',
  total         INTEGER NOT NULL DEFAULT 0,
  segments      INTEGER NOT NULL DEFAULT 1,
  created_by    BIGINT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ NULL,
  error         TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_campaign_company ON sms_campaign (company_id, id DESC);
CREATE TABLE IF NOT EXISTS sms_message (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  campaign_id          BIGINT NULL,
  bot_channel_user_id  INTEGER NULL,
  phone                VARCHAR(20) NOT NULL,
  name                 VARCHAR(255) NOT NULL DEFAULT '',
  text                 TEXT NOT NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'queued',
  error                TEXT NULL,
  sent_by              BIGINT NULL,
  bot_message_id       INTEGER NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at              TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_message_campaign ON sms_message (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_message_queue ON sms_message (status, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_sms_message_company ON sms_message (company_id, id DESC);
-- numbers that must not get SMS from this business
CREATE TABLE IF NOT EXISTS sms_optout (
  company_id  BIGINT NOT NULL,
  phone       VARCHAR(20) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, phone)
);
-- when a sender picked the row up (rows left in sending after a restart are closed as unknown, never sent twice)
ALTER TABLE sms_message ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;
