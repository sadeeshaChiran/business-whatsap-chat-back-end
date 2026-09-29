-- Agent Metra billing: payments (PayHere + bank transfer), token packs, platform settings (bank details).
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

-- Key-value settings managed by the super admin (bank details)
CREATE TABLE IF NOT EXISTS platform_setting (
  key         VARCHAR(60) PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_setting (key, value) VALUES
  ('bank_details', '{"bank_name": "", "branch": "", "account_name": "Metrocoding", "account_number": "", "note": "Use your company name as the reference."}')
ON CONFLICT (key) DO NOTHING;

-- Extra AI tokens companies can buy when they run out
CREATE TABLE IF NOT EXISTS token_pack (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  tokens      BIGINT NOT NULL,
  price       NUMERIC(12,2) NOT NULL,
  valid_days  INT NOT NULL DEFAULT 30,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO token_pack (name, tokens, price, valid_days, sort_order)
SELECT v.name, v.tokens, v.price, 30, v.sort_order
FROM (VALUES ('Small top-up', 100000, 750, 1), ('Medium top-up', 500000, 3000, 2), ('Large top-up', 2000000, 10000, 3)) AS v(name, tokens, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM token_pack);

-- Every payment: package (monthly / yearly) or token pack, by PayHere card or bank transfer
CREATE TABLE IF NOT EXISTS platform_payment (
  id                       SERIAL PRIMARY KEY,
  company_id               BIGINT NOT NULL,
  kind                     VARCHAR(20) NOT NULL,
  package_id               INT NULL,
  billing_cycle            VARCHAR(10) NULL,
  token_pack_id            INT NULL,
  description              VARCHAR(255) NOT NULL DEFAULT '',
  amount                   NUMERIC(12,2) NOT NULL,
  currency                 VARCHAR(3) NOT NULL DEFAULT 'LKR',
  method                   VARCHAR(20) NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'pending',
  auto_renew               BOOLEAN NOT NULL DEFAULT FALSE,
  order_id                 VARCHAR(60) NOT NULL UNIQUE,
  payhere_payment_id       VARCHAR(60) NULL,
  payhere_subscription_id  VARCHAR(60) NULL,
  slip_media_key           VARCHAR(255) NULL,
  slip_file_name           VARCHAR(255) NULL,
  note                     TEXT NOT NULL DEFAULT '',
  reject_reason            TEXT NULL,
  reviewed_by_user_id      BIGINT NULL,
  reviewed_at              TIMESTAMPTZ NULL,
  paid_at                  TIMESTAMPTZ NULL,
  invoice_no               VARCHAR(40) NULL,
  invoice_media_key        VARCHAR(255) NULL,
  created_by_user_id       BIGINT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_payment_company ON platform_payment (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_payment_status ON platform_payment (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_payment_payhere_sub ON platform_payment (payhere_subscription_id);

-- Auto-renew (PayHere recurring) and renewal reminders
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS payhere_subscription_id VARCHAR(60) NULL;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS reminded_7_at TIMESTAMPTZ NULL;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS reminded_1_at TIMESTAMPTZ NULL;
