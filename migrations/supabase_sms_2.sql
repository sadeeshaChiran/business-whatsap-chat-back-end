-- SMS part 2 (Oct 2026): Agent Metra SMS credits. Businesses send through the Agent Metra Notify.lk account and pay with
-- SMS credits (1 credit = 1 SMS part: 160 English / 70 Sinhala-Tamil characters). Free credits every month from the package,
-- more from SMS packs in Billing. Their own Notify.lk account still works and then no credits are used.
-- the SMS credits of a business (free credits of this month + bought credits)
CREATE TABLE IF NOT EXISTS sms_wallet (
  company_id        BIGINT PRIMARY KEY,
  balance           INTEGER NOT NULL DEFAULT 0,
  free_month        VARCHAR(7) NULL,
  free_used         INTEGER NOT NULL DEFAULT 0,
  sender_id         VARCHAR(11) NULL,
  sender_requested  VARCHAR(11) NULL,
  sender_status     VARCHAR(12) NOT NULL DEFAULT 'none',
  sender_note       TEXT NULL,
  sender_requested_at TIMESTAMPTZ NULL,
  footer            VARCHAR(80) NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- credits bought or given (spending is kept on each sms_message)
CREATE TABLE IF NOT EXISTS sms_wallet_tx (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL,
  credits     INTEGER NOT NULL,
  kind        VARCHAR(12) NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  ref         VARCHAR(60) NULL,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_wallet_tx_company ON sms_wallet_tx (company_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_wallet_tx_ref ON sms_wallet_tx (ref) WHERE ref IS NOT NULL;
-- SMS packs sold in Billing
CREATE TABLE IF NOT EXISTS sms_pack (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  credits     INTEGER NOT NULL,
  price       NUMERIC(12,2) NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sms_pack (name, credits, price, sort_order)
SELECT v.name, v.credits, v.price, v.sort_order
  FROM (VALUES ('1,000 SMS', 1000, 1200, 1), ('5,000 SMS', 5000, 5500, 2), ('10,000 SMS', 10000, 10000, 3)) AS v(name, credits, price, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM sms_pack);
-- what each SMS cost (credits = SMS parts, credits_free = the part paid with free credits), via = platform or own account
ALTER TABLE sms_message ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_message ADD COLUMN IF NOT EXISTS credits_free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sms_message ADD COLUMN IF NOT EXISTS via VARCHAR(10) NULL;
-- a payment for an SMS pack
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS sms_pack_id INTEGER NULL;
-- the credits promised at checkout (a pack changed later does not change a payment)
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS sms_credits INTEGER NULL;
-- the Agent Metra Notify.lk account (super admin fills it in)
INSERT INTO platform_setting (key, value) VALUES ('sms', '{"enabled": false, "user_id": "", "api_key": "", "default_sender": ""}'::jsonb)
ON CONFLICT (key) DO NOTHING;
