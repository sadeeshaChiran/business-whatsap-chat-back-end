-- Offer prices for packages (shown with an end date, e.g. until the AI price changes).
-- Safe to run many times. (No semicolons or quotes inside comments - the runner splits on them.)
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS offer_price_monthly NUMERIC(12,2) NULL;
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS offer_price_yearly NUMERIC(12,2) NULL;
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS offer_until DATE NULL;
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS offer_label VARCHAR(80) NOT NULL DEFAULT '';
