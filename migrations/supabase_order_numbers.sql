-- Order numbers per shop: every company counts its own orders 1, 2, 3 (bot_order.id stays the internal id).
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS order_no INTEGER NULL;

CREATE TABLE IF NOT EXISTS bot_order_counter (
  company_id BIGINT PRIMARY KEY,
  last_no    INTEGER NOT NULL DEFAULT 0
);

-- existing orders: numbered per company in the order they came (only orders without a number yet)
UPDATE bot_order o SET order_no = x.n
  FROM (SELECT a.id,
               COALESCE((SELECT MAX(b.order_no) FROM bot_order b WHERE b.company_id = a.company_id), 0)
               + ROW_NUMBER() OVER (PARTITION BY a.company_id ORDER BY a.id) AS n
          FROM bot_order a
         WHERE a.order_no IS NULL AND a.company_id IS NOT NULL) x
 WHERE x.id = o.id;

INSERT INTO bot_order_counter (company_id, last_no)
SELECT company_id, MAX(order_no) FROM bot_order WHERE company_id IS NOT NULL AND order_no IS NOT NULL GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE SET last_no = GREATEST(bot_order_counter.last_no, EXCLUDED.last_no);

CREATE UNIQUE INDEX IF NOT EXISTS bot_order_company_order_no ON bot_order (company_id, order_no);

-- new orders get the next number of their shop (numbers of deleted orders are not used again)
CREATE OR REPLACE FUNCTION bot_order_set_no() RETURNS trigger AS $$
BEGIN
  IF NEW.order_no IS NULL AND NEW.company_id IS NOT NULL THEN
    INSERT INTO bot_order_counter (company_id, last_no)
    VALUES (NEW.company_id, COALESCE((SELECT MAX(order_no) FROM bot_order WHERE company_id = NEW.company_id), 0) + 1)
    ON CONFLICT (company_id) DO UPDATE SET last_no = bot_order_counter.last_no + 1
    RETURNING last_no INTO NEW.order_no;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bot_order_set_no ON bot_order;
CREATE TRIGGER bot_order_set_no BEFORE INSERT ON bot_order FOR EACH ROW EXECUTE FUNCTION bot_order_set_no();
