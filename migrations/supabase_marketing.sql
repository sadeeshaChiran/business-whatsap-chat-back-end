-- Agent Metra marketing: ad tracking, Meta ads, Conversions API, WhatsApp broadcasts, audiences, opt-outs.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

-- 1) Which ad started the chat (from the Meta webhook referral)
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_source_id VARCHAR(64) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_source_type VARCHAR(20) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_headline TEXT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_source_url TEXT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_ctwa_clid VARCHAR(255) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_platform VARCHAR(20) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_referred_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_bot_conversation_ad ON bot_conversation (ad_source_id) WHERE ad_source_id IS NOT NULL;

-- 2 / 3 / 6) Meta ads connection per company (token never sent to the browser)
CREATE TABLE IF NOT EXISTS marketing_settings (
  company_id        BIGINT PRIMARY KEY,
  meta_user_token   TEXT NULL,
  token_expires_at  TIMESTAMPTZ NULL,
  ad_account_id     VARCHAR(40) NULL,
  ad_account_name   VARCHAR(255) NULL,
  ad_currency       VARCHAR(8) NULL,
  dataset_id        VARCHAR(40) NULL,
  capi_token        TEXT NULL,
  capi_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  capi_test_code    VARCHAR(40) NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ad id to campaign / ad set names (cache of the Meta API)
CREATE TABLE IF NOT EXISTS marketing_ad_cache (
  ad_id          VARCHAR(64) PRIMARY KEY,
  ad_name        VARCHAR(255) NULL,
  adset_id       VARCHAR(64) NULL,
  campaign_id    VARCHAR(64) NULL,
  campaign_name  VARCHAR(255) NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) Conversions API events sent (never twice)
CREATE TABLE IF NOT EXISTS marketing_capi_event (
  id           SERIAL PRIMARY KEY,
  company_id   BIGINT NOT NULL,
  event_name   VARCHAR(40) NOT NULL,
  ref          VARCHAR(80) NOT NULL,
  status       VARCHAR(10) NOT NULL,
  response     TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, event_name, ref)
);

-- 5) WhatsApp broadcasts with approved templates
CREATE TABLE IF NOT EXISTS marketing_broadcast (
  id                 SERIAL PRIMARY KEY,
  company_id         BIGINT NOT NULL,
  name               VARCHAR(255) NOT NULL,
  template_name      VARCHAR(255) NOT NULL,
  template_language  VARCHAR(20) NOT NULL DEFAULT 'en_US',
  body_params        JSONB NOT NULL DEFAULT '[]',
  audience           JSONB NOT NULL DEFAULT '{}',
  status             VARCHAR(12) NOT NULL DEFAULT 'draft',
  scheduled_at       TIMESTAMPTZ NULL,
  total              INT NOT NULL DEFAULT 0,
  created_by         BIGINT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ NULL,
  finished_at        TIMESTAMPTZ NULL,
  error              TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_broadcast_company ON marketing_broadcast (company_id, id DESC);

CREATE TABLE IF NOT EXISTS marketing_broadcast_recipient (
  id                   SERIAL PRIMARY KEY,
  broadcast_id         INT NOT NULL,
  bot_channel_user_id  INT NOT NULL,
  phone                VARCHAR(20) NOT NULL,
  name                 VARCHAR(255) NOT NULL DEFAULT '',
  status               VARCHAR(10) NOT NULL DEFAULT 'queued',
  message_id           INT NULL,
  provider_message_id  VARCHAR(128) NULL,
  error                TEXT NULL,
  sent_at              TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipient ON marketing_broadcast_recipient (broadcast_id, status);

-- customers who replied STOP (never get broadcasts again)
CREATE TABLE IF NOT EXISTS marketing_optout (
  company_id           BIGINT NOT NULL,
  bot_channel_user_id  INT NOT NULL,
  reason               VARCHAR(40) NOT NULL DEFAULT 'stop',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, bot_channel_user_id)
);

-- 6) audiences sent to Meta
CREATE TABLE IF NOT EXISTS marketing_audience (
  id              SERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  meta_audience_id VARCHAR(64) NULL,
  filters         JSONB NOT NULL DEFAULT '{}',
  size            INT NOT NULL DEFAULT 0,
  status          VARCHAR(10) NOT NULL DEFAULT 'created',
  error           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at       TIMESTAMPTZ NULL
);
