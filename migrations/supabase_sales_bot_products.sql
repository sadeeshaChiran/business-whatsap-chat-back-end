-- Sales bot: fuller product data for the bot + weight-based delivery fees.
-- Runs at startup (src/common/run-startup-migrations.ts). Safe to run many times.

-- Why customers love the product (the bot uses it to recommend and to answer price doubts)
ALTER TABLE product ADD COLUMN IF NOT EXISTS selling_points TEXT NOT NULL DEFAULT '';
-- Add-on products the bot may suggest after the main item (product ids, same company)
ALTER TABLE product ADD COLUMN IF NOT EXISTS related_product_ids INT[] NOT NULL DEFAULT '{}';
-- false = the bot never mentions or sells this product (it stays in the catalog)
ALTER TABLE product ADD COLUMN IF NOT EXISTS show_to_bot BOOLEAN NOT NULL DEFAULT TRUE;
-- Variant weight lives inside product_variant.variants JSON as "weight" (kg) - no column needed.

-- Optional weight rule per delivery zone:
-- fee = base fee + max(0, order weight - included_kg) * per_extra_kg   (exact kg, no rounding up)
ALTER TABLE bot_delivery_zone ADD COLUMN IF NOT EXISTS included_kg NUMERIC(10,3) NULL;
ALTER TABLE bot_delivery_zone ADD COLUMN IF NOT EXISTS per_extra_kg NUMERIC(12,2) NULL;

-- Order weight used for the delivery fee (kg)
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS total_weight_kg NUMERIC(10,3) NULL;
