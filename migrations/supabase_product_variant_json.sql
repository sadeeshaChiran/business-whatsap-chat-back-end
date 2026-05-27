-- Migrate product_variant from one row per option to one row per product (JSONB array).
-- Run once against Supabase Postgres after supabase_product_schema.sql.

ALTER TABLE product_variant ADD COLUMN IF NOT EXISTS variants JSONB;

UPDATE product_variant pv
SET variants = agg.variants
FROM (
  SELECT
    product_id,
    jsonb_agg(
      jsonb_build_object('variant_name', variant_name, 'variant_value', variant_value)
      ORDER BY id
    ) AS variants,
    MIN(id) AS keep_id
  FROM product_variant
  WHERE variant_name IS NOT NULL
  GROUP BY product_id
) agg
WHERE pv.id = agg.keep_id;

DELETE FROM product_variant
WHERE id NOT IN (
  SELECT MIN(id) FROM product_variant GROUP BY product_id
);

ALTER TABLE product_variant DROP COLUMN IF EXISTS variant_name;
ALTER TABLE product_variant DROP COLUMN IF EXISTS variant_value;

ALTER TABLE product_variant
  ALTER COLUMN variants SET NOT NULL,
  ALTER COLUMN variants SET DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variant_product_id ON product_variant (product_id);
