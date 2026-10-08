-- Agent Metra packages (Oct 2026) - run ONCE in the Supabase SQL editor (not run automatically).
-- Prices: normal price is safe for the 2027 Gemini price. Offer price until 31 Dec 2026 (Gemini launch price).
-- FINAL (8 Oct 2026): Rs 6,500 / 12,000 / 20,000 / 32,000 with 2,500 / 5,500 / 10,000 / 17,500 AI replies.
-- Launch offer until 31 Dec 2026: Rs 4,990 / 8,990 / 14,990 / 23,990. Yearly = 10 x monthly (2 months free).
-- AI replies are stored as tokens: 1 reply ~ 9,000 tokens (measured 8,100-12,000 incl. cached prompt; Super admin > Settings > credits).
-- Afterwards check each package in Super admin > Packages (agents, products, features).

-- Needs the max_services column: start the new API once first (it adds the column automatically).
INSERT INTO platform_package (code, name, description, price_monthly, price_yearly, tokens_per_month, max_agents, max_products, max_services, features, sort_order,
                              offer_price_monthly, offer_price_yearly, offer_until, offer_label, is_active, is_public)
VALUES
  ('free',     'Free',     'Try the AI sales bot on WhatsApp.',                 0,     0,      2700000,   1,    20,   10,   '["About 300 AI replies a month"]', 1,
   NULL,  NULL, NULL,         '',             TRUE, TRUE),
  ('starter',  'Starter',  'For small shops and Facebook pages.',               6500,  65000,  22500000,  3,    100,  30,   '["About 2,500 AI replies a month", "About 25-30 customers a day"]', 2,
   4990,  NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('growth',   'Growth',   'For online shops with daily orders.',               12000, 120000, 49500000,  5,    500,  100,  '["About 5,500 AI replies a month", "About 55-65 customers a day"]', 3,
   8990,  NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('business', 'Business', 'For busy shops and brands running ads.',            20000, 200000, 90000000,  10,   2000, 300,  '["About 10,000 AI replies a month", "About 100-120 customers a day"]', 4,
   14990, NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('pro',      'Pro',      'For big brands with ads every day.',                32000, 320000, 157500000, NULL, NULL, NULL, '["About 17,500 AI replies a month", "About 180-200 customers a day", "Everything in Business"]', 5,
   23990, NULL, '2026-12-31', 'Launch offer', TRUE, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  price_monthly = EXCLUDED.price_monthly, price_yearly = EXCLUDED.price_yearly, tokens_per_month = EXCLUDED.tokens_per_month,
  max_products = EXCLUDED.max_products, max_services = EXCLUDED.max_services,
  features = EXCLUDED.features, sort_order = EXCLUDED.sort_order,
  offer_price_monthly = EXCLUDED.offer_price_monthly, offer_price_yearly = EXCLUDED.offer_price_yearly,
  offer_until = EXCLUDED.offer_until, offer_label = EXCLUDED.offer_label,
  is_active = TRUE, is_public = TRUE, updated_at = NOW();

-- The old Scale package: hidden from the pricing page, companies already on it keep it.
UPDATE platform_package SET is_public = FALSE, updated_at = NOW() WHERE code = 'scale';

-- Reply count shown on the packages (about 9,000 tokens per bot reply).
INSERT INTO platform_setting (key, value) VALUES ('credits', '{"tokens_per_credit": 50000, "tokens_per_reply": 9000}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || '{"tokens_per_reply": 9000}'::jsonb, updated_at = NOW();
