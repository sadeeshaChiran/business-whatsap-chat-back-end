-- Dimension-based variant price matching on product (mirrors variant_image_match).
-- Example: dimensions ["Size"] + prices {"12-24 Months": 1850, "0-6 Months": 1650}

ALTER TABLE product
  ADD COLUMN IF NOT EXISTS variant_price_match JSONB;
