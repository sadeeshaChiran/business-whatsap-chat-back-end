-- Delivery weight rounding per zone: up (2.3 kg counts as 3 kg), nearest (2.3 -> 2, 2.5 -> 3) or exact.
-- Zones that already exist keep exact kg (their fees do not change). New zones count up, like most couriers.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_delivery_zone ADD COLUMN IF NOT EXISTS weight_rounding VARCHAR(10) NOT NULL DEFAULT 'exact';
ALTER TABLE bot_delivery_zone ALTER COLUMN weight_rounding SET DEFAULT 'up';
