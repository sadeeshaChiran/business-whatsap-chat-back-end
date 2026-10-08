-- Booking time checks: which statuses hold a booked time, and how many bookings may run at the same time.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS booking_block_status VARCHAR(20) NOT NULL DEFAULT 'requested';
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS booking_capacity INT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_bot_booking_company_date ON bot_booking (company_id, date);
