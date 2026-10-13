-- Every ad click that opened a chat (WhatsApp / Messenger / Instagram, Cloud API and QR WhatsApp), with the ad's text and picture,
-- so the inbox can show "came from this ad" and the ads reports can count people, leads, orders and lost leads per ad.
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_media_url TEXT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS ad_media_type VARCHAR(20) NULL;

CREATE TABLE IF NOT EXISTS marketing_ad_click (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  conversation_id      INT NOT NULL,
  bot_channel_user_id  BIGINT NULL,
  platform             VARCHAR(20) NOT NULL,
  ad_id                VARCHAR(64) NOT NULL,
  source_type          VARCHAR(20) NOT NULL DEFAULT 'ad',
  headline             TEXT NULL,
  body                 TEXT NULL,
  url                  TEXT NULL,
  media_url            TEXT NULL,
  media_type           VARCHAR(20) NULL,
  provider_message_id  VARCHAR(255) NULL,
  clicked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_ad_click_message ON marketing_ad_click (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_ad_click_company ON marketing_ad_click (company_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_click_ad ON marketing_ad_click (company_id, ad_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_click_conversation ON marketing_ad_click (conversation_id);

-- chats that came from an ad before this table existed
INSERT INTO marketing_ad_click (company_id, conversation_id, bot_channel_user_id, platform, ad_id, source_type, headline, body, url, clicked_at)
SELECT cu.company_id, c.id, c.bot_channel_user_id, COALESCE(c.ad_platform, cu.platform), c.ad_source_id, COALESCE(c.ad_source_type, 'ad'),
       c.ad_headline, c.ad_body, c.ad_source_url, COALESCE(c.ad_referred_at, c.created_at)
  FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
 WHERE c.ad_source_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM marketing_ad_click k WHERE k.conversation_id = c.id);
