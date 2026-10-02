-- Agent Metra: availability instead of stock counts.
-- Products, variants and services are simply Available or Unavailable. Everything starts as Available.
-- Stock numbers stay in the database (not deleted) but are not used any more.
-- Variant availability lives in the variant JSON as available true or false (missing means available).
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

ALTER TABLE product ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE bot_service ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;
