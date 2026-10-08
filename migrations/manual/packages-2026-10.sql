-- Agent Metra packages (Oct 2026) - run ONCE in the Supabase SQL editor (not run automatically).
-- Prices: normal price is safe for the 2027 Gemini price. Offer price until 31 Dec 2026 (Gemini launch price).
-- AI replies are stored as tokens: 1 reply ~ 7,500 tokens (Super admin > Settings > credits).
-- Afterwards check each package in Super admin > Packages (agents, products, features).

INSERT INTO platform_package (code, name, description, price_monthly, price_yearly, tokens_per_month, max_agents, features, sort_order,
                              offer_price_monthly, offer_price_yearly, offer_until, offer_label, is_active, is_public)
VALUES
  ('free',     'Free',     'Try the AI sales bot on WhatsApp.',                 0,     0,      2250000,   1,    '["About 300 AI replies a month"]', 1,
   NULL,  NULL, NULL,         '',             TRUE, TRUE),
  ('starter',  'Starter',  'For small shops and Facebook pages.',               8000,  80000,  18750000,  3,    '["About 25-35 customers a day"]', 2,
   5490,  NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('growth',   'Growth',   'For online shops with daily orders.',               14000, 140000, 37500000,  5,    '["About 55-65 customers a day"]', 3,
   8990,  NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('business', 'Business', 'For busy shops and brands running ads.',            25000, 250000, 75000000,  10,   '["About 110-130 customers a day"]', 4,
   14990, NULL, '2026-12-31', 'Launch offer', TRUE, TRUE),
  ('pro',      'Pro',      'For big brands with ads every day.',                35000, 350000, 112500000, NULL, '["About 170-200 customers a day", "Everything in Business"]', 5,
   19990, NULL, '2026-12-31', 'Launch offer', TRUE, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  price_monthly = EXCLUDED.price_monthly, price_yearly = EXCLUDED.price_yearly, tokens_per_month = EXCLUDED.tokens_per_month,
  features = EXCLUDED.features, sort_order = EXCLUDED.sort_order,
  offer_price_monthly = EXCLUDED.offer_price_monthly, offer_price_yearly = EXCLUDED.offer_price_yearly,
  offer_until = EXCLUDED.offer_until, offer_label = EXCLUDED.offer_label,
  is_active = TRUE, is_public = TRUE, updated_at = NOW();

-- The old Scale package: hidden from the pricing page, companies already on it keep it.
UPDATE platform_package SET is_public = FALSE, updated_at = NOW() WHERE code = 'scale';

-- Reply count shown on the packages (about 7,500 tokens per bot reply).
INSERT INTO platform_setting (key, value) VALUES ('credits', '{"tokens_per_credit": 50000, "tokens_per_reply": 7500}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || '{"tokens_per_reply": 7500}'::jsonb, updated_at = NOW();
