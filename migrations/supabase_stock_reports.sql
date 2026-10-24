-- Agent Metra: optional stock counts with low-stock alerts, and product and customer reports.
-- Stock counting is OFF for every product until the owner switches it on (track_stock).
-- When it is on, product.quantity (or the quantity of each variant option in the variant JSON) is the stock.
-- Orders take stock out and cancelled or deleted orders put it back, through product_stock_movement.
-- product_demand_event keeps what customers asked about in chats (photos shown, put in an order summary,
-- asked for while unavailable, asked for something the shop does not sell).
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

ALTER TABLE product ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE product ADD COLUMN IF NOT EXISTS low_stock_level INT NOT NULL DEFAULT 5;
ALTER TABLE product ADD COLUMN IF NOT EXISTS stock_auto_off BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE product ADD COLUMN IF NOT EXISTS reorder_days INT;

CREATE TABLE IF NOT EXISTS product_stock_movement (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  product_id INT NOT NULL,
  option_label VARCHAR(255),
  order_id INT,
  change INT NOT NULL,
  stock_after INT NOT NULL,
  reason VARCHAR(30) NOT NULL DEFAULT 'adjust',
  note VARCHAR(255),
  created_by_user_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_movement_product ON product_stock_movement (company_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movement_order ON product_stock_movement (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_demand_event (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  product_id INT,
  event VARCHAR(20) NOT NULL,
  option_label VARCHAR(255),
  query_text VARCHAR(300),
  bot_channel_user_id INT,
  conversation_id INT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demand_company_time ON product_demand_event (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_company_product ON product_demand_event (company_id, product_id, event);
CREATE UNIQUE INDEX IF NOT EXISTS uq_demand_once_a_day ON product_demand_event (
  company_id, COALESCE(conversation_id, 0), COALESCE(product_id, 0), event, day, md5(COALESCE(query_text, ''))
);
