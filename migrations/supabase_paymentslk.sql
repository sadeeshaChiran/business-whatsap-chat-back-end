-- Payments.lk (Nov 2026): card payments in rupees through the hosted checkout of Payments.lk (PAYable).
-- the checkout, the Payments.lk payment and the saved card (auto-renew) of each payment
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS plk_checkout_id VARCHAR(80) NULL;
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS plk_payment_id VARCHAR(80) NULL;
ALTER TABLE platform_payment ADD COLUMN IF NOT EXISTS plk_card_id VARCHAR(80) NULL;
CREATE INDEX IF NOT EXISTS idx_platform_payment_plk_checkout ON platform_payment (plk_checkout_id) WHERE plk_checkout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_payment_plk_payment ON platform_payment (plk_payment_id) WHERE plk_payment_id IS NOT NULL;
-- auto-renew with the saved card: the card, and the tries of the current renewal (up to 3, one a day)
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS plk_card_id VARCHAR(80) NULL;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS plk_renew_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS plk_renew_last_at TIMESTAMPTZ NULL;
