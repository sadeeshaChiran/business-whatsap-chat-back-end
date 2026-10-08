-- Free delivery when the order subtotal reaches an amount (NULL = never free). Used by the bot and the order total.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS free_delivery_over NUMERIC(12,2) NULL;
