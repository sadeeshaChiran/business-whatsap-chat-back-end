-- ============================================================================================
-- Agent Metra – data cleanup (2026-10-24)
--
-- KEEPS
--   * VORA and Chu.lk with their REAL customer chats, orders, products, settings and training
--   * the Agent Metra company (admin agentmetra@gmail.com) if it already exists
--   * the super admin login, packages, token packs, industries and platform settings
-- REMOVES
--   * every other company (old scale-test shops and the old 10 demo companies) with ALL their data
--   * simulator / scale-test customers (numbers starting with 999) inside VORA and Chu.lk,
--     with their chats, orders, notes, notifications and AI usage rows
--   * the unused test package "scale" (hidden, not deleted, if anything still points at it)
--
-- Safe to run more than once. Stops with an error (nothing changed) if VORA or Chu.lk is missing.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 01-cleanup-keep-vora-chulk.sql
-- ============================================================================================
BEGIN;
SET search_path = public;

CREATE TEMP TABLE _keep_co ON COMMIT DROP AS
  SELECT id FROM companies WHERE LOWER(TRIM(company_name)) IN ('vora', 'chu.lk')
  UNION
  SELECT c.id FROM companies c JOIN app_user u ON u.company_id = c.id WHERE LOWER(u.email) = 'agentmetra@gmail.com';

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM companies WHERE LOWER(TRIM(company_name)) IN ('vora', 'chu.lk')) <> 2 THEN
    RAISE EXCEPTION 'Expected exactly 2 companies named VORA and Chu.lk – nothing was changed.';
  END IF;
END $$;

CREATE TEMP TABLE _drop_co ON COMMIT DROP AS SELECT id FROM companies WHERE id NOT IN (SELECT id FROM _keep_co);
CREATE TEMP TABLE _drop_user ON COMMIT DROP AS SELECT id FROM app_user WHERE company_id IN (SELECT id FROM _drop_co);
CREATE TEMP TABLE _drop_cu ON COMMIT DROP AS
  SELECT id FROM bot_channel_user
  WHERE company_id IN (SELECT id FROM _drop_co)
     OR regexp_replace(COALESCE(external_user_id, ''), '\D', '', 'g') LIKE '999%';
CREATE TEMP TABLE _drop_conv ON COMMIT DROP AS SELECT id FROM bot_conversation WHERE bot_channel_user_id IN (SELECT id FROM _drop_cu);
CREATE TEMP TABLE _drop_order ON COMMIT DROP AS
  SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _drop_co) OR bot_channel_user_id IN (SELECT id FROM _drop_cu);
CREATE TEMP TABLE _drop_product ON COMMIT DROP AS SELECT id FROM product WHERE company_id IN (SELECT id FROM _drop_co);

-- report what will go
DO $$
BEGIN
  RAISE NOTICE 'Removing % companies, % logins, % customers (incl. test 999 numbers), % chats, % orders, % products',
    (SELECT COUNT(*) FROM _drop_co), (SELECT COUNT(*) FROM _drop_user), (SELECT COUNT(*) FROM _drop_cu),
    (SELECT COUNT(*) FROM _drop_conv), (SELECT COUNT(*) FROM _drop_order), (SELECT COUNT(*) FROM _drop_product);
END $$;

-- 1. rows hanging off chats, customers and orders (only when the table / column exists)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('conversation_id', 'bot_channel_user_id', 'channel_user_id', 'order_id')
      AND table_name NOT IN ('bot_conversation', 'bot_order', 'platform_payment')
  LOOP
    EXECUTE format('DELETE FROM %I WHERE %I::text IN (SELECT id::text FROM %s)', r.table_name, r.column_name,
      CASE r.column_name WHEN 'conversation_id' THEN '_drop_conv' WHEN 'order_id' THEN '_drop_order' ELSE '_drop_cu' END);
  END LOOP;
END $$;
DELETE FROM bot_message WHERE conversation_id IN (SELECT id FROM _drop_conv);
DELETE FROM bot_order WHERE id IN (SELECT id FROM _drop_order);
DELETE FROM bot_conversation WHERE id IN (SELECT id FROM _drop_conv);
DELETE FROM bot_channel_user WHERE id IN (SELECT id FROM _drop_cu);

-- 2. products of removed companies
DELETE FROM product_variant WHERE product_id IN (SELECT id FROM _drop_product);
DELETE FROM product WHERE id IN (SELECT id FROM _drop_product);

-- 3. references to removed logins: clear them where allowed, delete the row where not
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'app_user'
      AND column_name IN ('created_by', 'user_id', 'agent_id', 'assigned_agent_id', 'sender_user_id', 'feedback_by', 'admin_user_id', 'app_user_id', 'updated_by')
  LOOP
    IF r.is_nullable = 'YES' THEN
      EXECUTE format('UPDATE %I SET %I = NULL WHERE %I::text IN (SELECT id::text FROM _drop_user)', r.table_name, r.column_name, r.column_name);
    ELSE
      EXECUTE format('DELETE FROM %I WHERE %I::text IN (SELECT id::text FROM _drop_user)', r.table_name, r.column_name);
    END IF;
  END LOOP;
END $$;

-- 4. every table with a company_id: delete the removed companies' rows.
--    Repeated until nothing is left, so the order of foreign keys does not matter.
DO $$
DECLARE r RECORD; pass INT; left_over INT;
BEGIN
  FOR pass IN 1..8 LOOP
    left_over := 0;
    FOR r IN
      SELECT DISTINCT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND c.table_name NOT IN ('app_user', 'platform_package')
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE company_id::text IN (SELECT id::text FROM _drop_co)', r.table_name);
      EXCEPTION WHEN foreign_key_violation THEN
        left_over := left_over + 1;
      END;
    END LOOP;
    EXIT WHEN left_over = 0;
  END LOOP;
  IF left_over > 0 THEN RAISE EXCEPTION 'Could not remove all rows (% tables still blocked by foreign keys)', left_over; END IF;
END $$;

-- company-only packages that belonged to removed companies
DELETE FROM platform_package WHERE company_id IN (SELECT id FROM _drop_co)
  AND id NOT IN (SELECT package_id FROM company_subscription WHERE package_id IS NOT NULL);

-- 5. logins and companies
UPDATE companies SET admin_user_id = NULL WHERE id IN (SELECT id FROM _drop_co);
DELETE FROM app_user WHERE id IN (SELECT id FROM _drop_user);
DELETE FROM companies WHERE id IN (SELECT id FROM _drop_co);

-- 6. the "scale" test package (Rs 7,500 with fewer credits than Free) – hide it from the website and billing
UPDATE platform_package SET is_public = FALSE, is_active = FALSE, updated_at = NOW()
WHERE code = 'scale' AND NOT EXISTS (SELECT 1 FROM company_subscription s WHERE s.package_id = platform_package.id);

DO $$
BEGIN
  RAISE NOTICE 'Done. Companies left: %', (SELECT string_agg(company_name, ', ' ORDER BY id) FROM companies);
END $$;
COMMIT;
