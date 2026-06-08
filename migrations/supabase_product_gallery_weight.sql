-- Product gallery (common images) and weight for delivery calculations.

ALTER TABLE product ADD COLUMN IF NOT EXISTS weight DECIMAL(10, 3);
ALTER TABLE product ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::jsonb;
