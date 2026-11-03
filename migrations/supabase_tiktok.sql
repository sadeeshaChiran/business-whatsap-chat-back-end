-- TikTok Business Messaging (Oct 2026): one TikTok Business account per company, direct messages in the inbox
CREATE TABLE IF NOT EXISTS tiktok_connection (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  business_id          TEXT NOT NULL,
  username             TEXT NULL,
  display_name         TEXT NULL,
  profile_image        TEXT NULL,
  access_token         TEXT NOT NULL,
  refresh_token        TEXT NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  refresh_expires_at   TIMESTAMPTZ NOT NULL,
  scope                TEXT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'CONNECTED',
  last_error           TEXT NULL,
  last_event_at        TIMESTAMPTZ NULL,
  connected_by         BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_connection_business ON tiktok_connection (business_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_connection_company ON tiktok_connection (company_id);

-- packages that switch Instagram off also switch TikTok off (a package without the key allows it)
UPDATE platform_package SET limits = COALESCE(limits, '{}'::jsonb) || jsonb_build_object('tiktok', false)
 WHERE COALESCE(limits, '{}'::jsonb) ->> 'instagram' = 'false' AND NOT (COALESCE(limits, '{}'::jsonb) ? 'tiktok');
