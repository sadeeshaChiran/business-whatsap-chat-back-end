-- PayPal (Nov 2026): prices stay in rupees, PayPal is charged in US dollars at the rate of the day.
-- what was charged in dollars and at which rate
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(12,2) NULL;
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS usd_rate NUMERIC(12,4) NULL;
-- PayPal order (one payment) or subscription (auto-renew), and the capture / sale id of the money
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS paypal_order_id VARCHAR(60) NULL;
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS paypal_subscription_id VARCHAR(60) NULL;
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS paypal_payment_id VARCHAR(60) NULL;
CREATE INDEX IF NOT EXISTS idx_platform_payment_paypal_order ON platform_payment (paypal_order_id) WHERE paypal_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_payment_paypal_sub ON platform_payment (paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_payment_paypal_payment ON platform_payment (paypal_payment_id) WHERE paypal_payment_id IS NOT NULL;
-- the PayPal subscription that renews the package
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS paypal_subscription_id VARCHAR(60) NULL;
-- rate settings: auto = the rate of the day, fixed = the super admin rate, markup = percent added (PayPal fees)
INSERT INTO platform_setting (key, value) VALUES ('paypal', '{"rate_mode": "auto", "fixed_rate": null, "markup_percent": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;
