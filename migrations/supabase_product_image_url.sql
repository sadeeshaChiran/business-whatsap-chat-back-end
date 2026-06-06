-- Main product image (used when has_variants = false).
-- Variant images stay in product_variant.variants JSONB (image_url per combination).

ALTER TABLE product ADD COLUMN IF NOT EXISTS image_url TEXT;
