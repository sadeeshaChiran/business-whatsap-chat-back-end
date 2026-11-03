-- Product brand (optional): shown to customers, used by the AI bot to find products ("Nike shoes", "Casio watch"). Safe to run more than once.
ALTER TABLE product ADD COLUMN IF NOT EXISTS brand VARCHAR(120);
CREATE INDEX IF NOT EXISTS idx_product_company_brand ON product (company_id, LOWER(brand)) WHERE brand IS NOT NULL;
