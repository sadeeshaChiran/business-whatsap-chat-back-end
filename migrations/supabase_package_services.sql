-- Package limit: max services a company can add (NULL = unlimited), like max_products.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS max_services INT NULL;
