CREATE TABLE IF NOT EXISTS meta_page_connections (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  company_name TEXT,
  meta_user_id TEXT NOT NULL DEFAULT '',
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL DEFAULT '',
  page_access_token TEXT NOT NULL,
  instagram_business_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED',
  token_expires_at TIMESTAMPTZ,
  scopes TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_page_connections_company_page UNIQUE (company_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_page_connections_company_id
  ON meta_page_connections (company_id);

CREATE TABLE IF NOT EXISTS meta_oauth_pending (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL UNIQUE,
  meta_user_id TEXT NOT NULL DEFAULT '',
  pages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_oauth_pending_expires_at
  ON meta_oauth_pending (expires_at);

ALTER TABLE meta_oauth_pending
  ADD COLUMN IF NOT EXISTS meta_user_id TEXT NOT NULL DEFAULT '';
