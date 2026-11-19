-- Delivery fee rules by item counts per shop (for example 1-2 T-shirts Rs 130, 3 or more free, pants Rs 425, kit free).
-- NULL for every shop = nothing changes (zone fee and free delivery over work as before).
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS delivery_rules JSONB;
