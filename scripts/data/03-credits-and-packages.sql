-- ============================================================================================
-- Agent Metra – credits and packages (2026-10-24). Safe to run again.
--
-- 1 credit = 100,000 AI tokens ≈ ONE average customer chat (measured on our own data, Oct 2026:
-- a bot reply ≈ 12,500 tokens incl. the cached business prompt; an average chat ≈ 8 bot replies).
-- Every AI job uses credits by its real size: a short chat or a comment reply ≈ 0.1-0.3 credit,
-- a long buying chat 2+ credits, a product photo description ≈ 0.02 credit.
--
-- Packages are counted in customer chats a month. Launch prices until 31 Dec 2026.
-- AI cost per credit ≈ Rs 3.4-6.8 (see the cost calculator), so every package keeps ≥ 55-65 % margin
-- at full use on the launch price with today's model prices, more at normal use.
-- Prices / chats can be changed later in Super admin → Packages.
-- ============================================================================================
BEGIN;
SET search_path = public;

INSERT INTO platform_setting (key, value, updated_at)
VALUES ('credits', '{"tokens_per_credit": 100000, "tokens_per_reply": 12500}'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- code, chats a month, regular price, yearly, launch price, agents, products, services, description, features
WITH p(code, chats, monthly, yearly, offer, agents, products, services, description, features) AS (VALUES
  ('free',      30,     0,      0,  NULL::numeric, 1,    20,   10, 'Try the AI agent on WhatsApp.',
     '["About 30 customer chats a month", "WhatsApp AI agent and shared inbox", "Orders, bookings and invoices"]'),
  ('starter',  250,  6500,  65000,  4990, 3,   150,   40, 'For small shops, salons and Facebook pages.',
     '["About 250 customer chats a month (≈ 8 a day)", "WhatsApp, Messenger and Instagram", "Comment replies and private messages"]'),
  ('growth',   550, 12000, 120000,  8990, 5,  1000,  150, 'For online shops and service businesses with daily enquiries.',
     '["About 550 customer chats a month (≈ 18 a day)", "CRM pipeline, follow-ups and broadcasts", "Ad results: chats and sales per ad"]'),
  ('business',1000, 20000, 200000, 14990, 10, 3000,  400, 'For busy shops, brands running ads and high-value sales teams.',
     '["About 1,000 customer chats a month (≈ 33 a day)", "Everything in Growth", "Meta ads, audiences and Conversions API"]'),
  ('pro',     1600, 32000, 320000, 23990, NULL, NULL, NULL, 'For big brands with ads every day.',
     '["About 1,600 customer chats a month (≈ 53 a day)", "Unlimited agents, products and services", "Everything in Business"]')
)
UPDATE platform_package pk SET
  tokens_per_month = p.chats * 100000,
  price_monthly = p.monthly, price_yearly = p.yearly,
  offer_price_monthly = p.offer, offer_label = CASE WHEN p.offer IS NULL THEN '' ELSE 'Launch offer' END,
  offer_until = CASE WHEN p.offer IS NULL THEN NULL ELSE DATE '2026-12-31' END,
  max_agents = p.agents, max_products = p.products, max_services = p.services,
  description = p.description, features = p.features::jsonb, updated_at = NOW()
FROM p WHERE pk.code = p.code AND pk.company_id IS NULL;

-- top-ups (valid 30 days): cheaper per chat the more you buy
UPDATE token_pack SET name = '100 chats',   tokens = 10000000,  price = 1500,  valid_days = 30, is_active = TRUE WHERE sort_order = 11;
UPDATE token_pack SET name = '300 chats',   tokens = 30000000,  price = 3900,  valid_days = 30, is_active = TRUE WHERE sort_order = 12;
UPDATE token_pack SET name = '1,000 chats', tokens = 100000000, price = 12900, valid_days = 30, is_active = TRUE WHERE sort_order = 13;

DO $$ BEGIN RAISE NOTICE 'Credits: 1 credit = 100,000 tokens (≈ 1 customer chat). Packages: %',
  (SELECT string_agg(code || ' ' || (tokens_per_month / 100000) || ' chats', ', ' ORDER BY sort_order) FROM platform_package WHERE is_public AND company_id IS NULL); END $$;
COMMIT;
