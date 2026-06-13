-- Remove secondary price fields from product catalog.

UPDATE product_variant
SET variants = COALESCE(
  (
    SELECT jsonb_agg(elem - 'secondary_price_1' - 'secondary_price_2')
    FROM jsonb_array_elements(variants) AS elem
  ),
  '[]'::jsonb
)
WHERE variants IS NOT NULL
  AND variants::text LIKE '%secondary_price_%';

ALTER TABLE product DROP COLUMN IF EXISTS secondary_price_1;
ALTER TABLE product DROP COLUMN IF EXISTS secondary_price_2;
