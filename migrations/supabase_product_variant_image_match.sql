-- Dimension-based variant image matching on product (non-destructive).
-- Example: dimensions ["Color"] + images {"Red": "...", "Blue": "..."}
-- Or dimensions ["Color","Size"] + 4 images for each combination.

ALTER TABLE product
  ADD COLUMN IF NOT EXISTS variant_image_match JSONB;
