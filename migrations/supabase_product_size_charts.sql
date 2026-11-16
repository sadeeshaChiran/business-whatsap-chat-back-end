-- Products - gallery photos marked as size charts. The AI bot sends them when a customer asks about sizes
-- and never sends them as a normal product photo. Safe to run many times.
ALTER TABLE product ADD COLUMN IF NOT EXISTS size_charts JSONB NOT NULL DEFAULT '[]'::jsonb;
