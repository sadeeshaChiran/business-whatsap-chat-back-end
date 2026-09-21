-- Keep Meta contacts separate when a company connects more than one Page/account.
ALTER TABLE bot_channel_user ADD COLUMN IF NOT EXISTS source_account_id varchar(255);

DROP INDEX IF EXISTS uq_bot_channel_user_company_platform_external;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_channel_user_company_platform_account_external
  ON bot_channel_user (
    company_id,
    platform,
    COALESCE(source_account_id, ''),
    external_user_id
  );

CREATE INDEX IF NOT EXISTS idx_bot_channel_user_meta_account
  ON bot_channel_user (company_id, platform, source_account_id);
