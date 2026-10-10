-- Bookings like orders: service price and length kept on the booking (for the booking invoice PDF) and the invoice link.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) NULL;
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS duration_min INT NULL;
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS invoice_url VARCHAR(1000) NULL;
CREATE INDEX IF NOT EXISTS idx_bot_booking_channel_user ON bot_booking (bot_channel_user_id);
