-- ============================================================================================
-- Agent Metra – FRESH START for VORA and Chu.lk (go-live 2026-10-24)
--
-- DELETES for VORA and Chu.lk: every customer, chat, message, order (with items and status history),
-- booking, notification, customer note, lead / CRM record, form answer, ad click, comment and AI usage row.
-- KEEPS: logins, products, categories, variants, photos, delivery zones, services, bot settings,
-- AI knowledge / training, labels, templates, flows, campaigns, channels (WhatsApp / Facebook / Instagram),
-- package and payments.
--
-- RUNS ONLY ONCE: it saves the marker "fresh_start_vora_chulk" in platform_setting. Running the file again
-- (or final-data-update.sql again) after go-live does NOTHING here, so real chats are never deleted later.
-- To run it again on purpose: DELETE FROM platform_setting WHERE key = 'fresh_start_vora_chulk';
-- ============================================================================================
BEGIN;
SET search_path = public;

CREATE TEMP TABLE _reset_co ON COMMIT DROP AS
  SELECT id FROM companies
  WHERE LOWER(TRIM(company_name)) IN ('vora', 'chu.lk')
    AND NOT EXISTS (SELECT 1 FROM platform_setting WHERE key = 'fresh_start_vora_chulk');
CREATE TEMP TABLE _reset_cu ON COMMIT DROP AS SELECT id FROM bot_channel_user WHERE company_id IN (SELECT id FROM _reset_co);
CREATE TEMP TABLE _reset_conv ON COMMIT DROP AS SELECT id FROM bot_conversation WHERE bot_channel_user_id IN (SELECT id FROM _reset_cu);
CREATE TEMP TABLE _reset_order ON COMMIT DROP AS
  SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _reset_co) OR bot_channel_user_id IN (SELECT id FROM _reset_cu);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM _reset_co) = 0 THEN
    RAISE NOTICE 'Fresh start already done earlier (marker found) – VORA and Chu.lk chats are NOT touched.';
  ELSE
    RAISE NOTICE 'Fresh start: deleting % customers, % chats, % messages, % orders in VORA and Chu.lk',
      (SELECT COUNT(*) FROM _reset_cu), (SELECT COUNT(*) FROM _reset_conv),
      (SELECT COUNT(*) FROM bot_message WHERE conversation_id IN (SELECT id FROM _reset_conv)), (SELECT COUNT(*) FROM _reset_order);
  END IF;
END $$;

-- 1. rows hanging off chats, customers and orders (order items, status history, leads, notes, tags, form answers …)
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
      CASE r.column_name WHEN 'conversation_id' THEN '_reset_conv' WHEN 'order_id' THEN '_reset_order' ELSE '_reset_cu' END);
  END LOOP;
END $$;
DELETE FROM bot_message WHERE conversation_id IN (SELECT id FROM _reset_conv);
DELETE FROM bot_order WHERE id IN (SELECT id FROM _reset_order);
DELETE FROM bot_conversation WHERE id IN (SELECT id FROM _reset_conv);
DELETE FROM bot_channel_user WHERE id IN (SELECT id FROM _reset_cu);

-- 2. customer activity kept per company (only tables that exist in this database)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bot_ai_usage', 'bot_booking', 'bot_notification', 'bot_customer_note', 'bot_contact_tag',
                           'customers', 'crm_contact', 'crm_task', 'chat_form_invite', 'chat_form_submission',
                           'automation_run', 'automation_comment_reply', 'marketing_ad_click', 'marketing_capi_event',
                           'marketing_optout', 'social_comment', 'company_activity_log']
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'company_id') THEN
      EXECUTE format('DELETE FROM %I WHERE company_id::text IN (SELECT id::text FROM _reset_co)', t);
    END IF;
  END LOOP;
END $$;

-- 3. remember that it ran, so it never deletes real chats again
INSERT INTO platform_setting (key, value, updated_at)
SELECT 'fresh_start_vora_chulk', jsonb_build_object('done_at', NOW(), 'companies', (SELECT jsonb_agg(id) FROM _reset_co)), NOW()
WHERE EXISTS (SELECT 1 FROM _reset_co)
ON CONFLICT (key) DO NOTHING;

COMMIT;
