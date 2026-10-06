-- Agent Metra marketing campaigns, short links and QR codes.
-- A campaign groups Meta ads, short links and broadcasts. When a customer comes from one of them,
-- the chat is linked to the campaign and the AI bot answers about that campaign.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

CREATE TABLE IF NOT EXISTS marketing_campaign (
  id                SERIAL PRIMARY KEY,
  company_id        BIGINT NOT NULL,
  name              VARCHAR(120) NOT NULL,
  status            VARCHAR(10) NOT NULL DEFAULT 'active',
  starts_at         DATE NULL,
  ends_at           DATE NULL,
  offer_text        TEXT NOT NULL DEFAULT '',
  bot_instructions  TEXT NOT NULL DEFAULT '',
  product_ids       JSONB NOT NULL DEFAULT '[]',
  meta_campaign_ids JSONB NOT NULL DEFAULT '[]',
  meta_ad_ids       JSONB NOT NULL DEFAULT '[]',
  tag               VARCHAR(40) NOT NULL DEFAULT '',
  created_by        BIGINT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_company ON marketing_campaign (company_id, id DESC);

-- Short links: /l/slug opens a chat (WhatsApp, Messenger or Instagram) with a ready message
CREATE TABLE IF NOT EXISTS marketing_link (
  id             SERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL,
  slug           VARCHAR(40) NOT NULL UNIQUE,
  name           VARCHAR(120) NOT NULL,
  channel        VARCHAR(12) NOT NULL DEFAULT 'whatsapp',
  target         VARCHAR(120) NOT NULL DEFAULT '',
  prefill_text   VARCHAR(500) NOT NULL DEFAULT '',
  campaign_id    INT NULL,
  tag            VARCHAR(40) NOT NULL DEFAULT '',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  clicks         INT NOT NULL DEFAULT 0,
  created_by     BIGINT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_link_company ON marketing_link (company_id, id DESC);

-- One row per click (ip is stored only as a hash)
CREATE TABLE IF NOT EXISTS marketing_link_click (
  id          BIGSERIAL PRIMARY KEY,
  link_id     INT NOT NULL,
  ip_hash     VARCHAR(64) NULL,
  user_agent  VARCHAR(300) NULL,
  referer     VARCHAR(300) NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_link_click ON marketing_link_click (link_id, created_at);

-- Which campaign / link the chat came from (latest wins)
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS campaign_id INT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS campaign_source VARCHAR(12) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS campaign_at TIMESTAMPTZ NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS link_id INT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_body TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_conversation_campaign ON bot_conversation (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_conversation_link ON bot_conversation (link_id) WHERE link_id IS NOT NULL;

-- Broadcasts can belong to a campaign (replies are then linked to it)
ALTER TABLE marketing_broadcast ADD COLUMN IF NOT EXISTS campaign_id INT NULL;
ALTER TABLE marketing_broadcast_recipient ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;

-- ad cache per company (one ad id can only belong to one ad account, so the key stays the ad id)
ALTER TABLE marketing_ad_cache ADD COLUMN IF NOT EXISTS company_id BIGINT NULL;
ALTER TABLE marketing_ad_cache ADD COLUMN IF NOT EXISTS lookup_failed_at TIMESTAMPTZ NULL;

-- Messenger / Instagram ref or ad that arrives before the first message (kept 30 minutes)
CREATE TABLE IF NOT EXISTS marketing_pending_ref (
  id                BIGSERIAL PRIMARY KEY,
  platform          VARCHAR(12) NOT NULL,
  external_user_id  VARCHAR(128) NOT NULL,
  data              JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_pending_ref ON marketing_pending_ref (platform, external_user_id);
