-- Product catalog tables for Supabase (safe: does not touch existing public tables).
-- Run once against your Supabase Postgres database.

CREATE TABLE IF NOT EXISTS product_catergory (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  company_id INTEGER,
  is_common BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_category_company_name UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS product (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sku VARCHAR(100) NOT NULL DEFAULT '',
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'In Stock',
  category_id INTEGER NOT NULL REFERENCES product_catergory (id) ON UPDATE CASCADE,
  company_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  has_variants BOOLEAN NOT NULL DEFAULT FALSE,
  image_url TEXT,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  vector_embedding BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_company_id ON product (company_id);
CREATE INDEX IF NOT EXISTS idx_product_category_id ON product (category_id);
CREATE INDEX IF NOT EXISTS idx_product_is_deleted ON product (is_deleted);

CREATE TABLE IF NOT EXISTS product_variant (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES product (id) ON DELETE CASCADE ON UPDATE CASCADE,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_variant_product_id ON product_variant (product_id);
