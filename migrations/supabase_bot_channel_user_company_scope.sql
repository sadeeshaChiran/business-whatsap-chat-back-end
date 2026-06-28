-- Each company owns its own WhatsApp channel users (same phone can exist per tenant).
ALTER TABLE bot_channel_user DROP CONSTRAINT IF EXISTS uq_bot_channel_user_platform_external;
DROP INDEX IF EXISTS uq_bot_channel_user_platform_external;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_channel_user_company_platform_external
  ON bot_channel_user (company_id, platform, external_user_id);
