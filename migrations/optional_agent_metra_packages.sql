-- OPTIONAL (not run automatically). Run once in Supabase to set the 4 Agent Metra packages and 3 top-ups.
-- 1 credit = 50,000 AI tokens. Prices in LKR. Yearly = 10 x monthly (2 months free).
-- After this you can still change everything in Agent Metra admin.

INSERT INTO platform_setting (key, value) VALUES ('credits', '{"tokens_per_credit": 50000}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

INSERT INTO platform_package (code, name, description, price_monthly, price_yearly, tokens_per_month, max_agents, features, sort_order, is_active, is_public)
VALUES
  ('free',   'Free',   'Try Agent Metra on your own business.',        0,     0,      1500000,  2,    '["AI sales bot on WhatsApp, Messenger and Instagram", "Orders, bookings and leads", "About 300 bot replies a month"]', 1, TRUE, TRUE),
  ('small',  'Small',  'For small shops – about 5 chats a day.',       2500,  25000,  6000000,  3,    '["Everything in Free", "About 1,200 bot replies a month", "Invoices, delivery fees by weight"]', 2, TRUE, TRUE),
  ('growth', 'Medium', 'For growing businesses – about 20 chats a day.', 6500, 65000, 24000000, 8,    '["Everything in Small", "About 4,800 bot replies a month", "Up to 8 agents"]', 3, TRUE, TRUE),
  ('scale',  'Busy',   'For busy businesses – about 60 chats a day.',  15000, 150000, 72000000, NULL, '["Everything in Medium", "About 14,400 bot replies a month", "Unlimited agents"]', 4, TRUE, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly, tokens_per_month = EXCLUDED.tokens_per_month, max_agents = EXCLUDED.max_agents,
  features = EXCLUDED.features, sort_order = EXCLUDED.sort_order, is_active = TRUE, is_public = TRUE, updated_at = NOW();

UPDATE token_pack SET is_active = FALSE;
INSERT INTO token_pack (name, tokens, price, valid_days, sort_order, is_active) VALUES
  ('40 credits',  2000000,  700,  30, 1, TRUE),
  ('120 credits', 6000000,  1800, 30, 2, TRUE),
  ('400 credits', 20000000, 5000, 30, 3, TRUE);
