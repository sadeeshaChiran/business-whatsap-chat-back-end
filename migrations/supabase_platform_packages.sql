-- Agent Metra platform: super admin, packages, subscriptions, token quotas.
-- Runs at startup (src/common/run-startup-migrations.ts). Safe to run many times.
-- (No semicolons or quotes inside comments - the runner splits on them.)

-- Metrocoding team accounts (also set from SUPER_ADMIN_EMAILS at startup)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Packages the super admin sells. code = companies.plan (free, growth, scale ...)
CREATE TABLE IF NOT EXISTS platform_package (
  id                  SERIAL PRIMARY KEY,
  code                VARCHAR(40) NOT NULL UNIQUE,
  name                VARCHAR(120) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  price_monthly       NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_yearly        NUMERIC(12,2) NOT NULL DEFAULT 0,
  tokens_per_month    BIGINT NOT NULL DEFAULT 0,
  max_agents          INT NULL,
  max_products        INT NULL,
  features            JSONB NOT NULL DEFAULT '[]',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_public           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_package (code, name, description, price_monthly, price_yearly, tokens_per_month, max_agents, features, sort_order)
VALUES
  ('free',   'Free',   'Start with the AI sales bot and up to 3 agents.', 0,    0,     50000,   3,    '["AI sales bot", "WhatsApp, Messenger, Instagram", "Up to 3 agents"]', 1),
  ('growth', 'Growth', 'For growing shops with more chats.',            3500, 35000, 500000,  10,   '["Everything in Free", "Up to 10 agents", "More AI tokens"]', 2),
  ('scale',  'Scale',  'For busy businesses and teams.',                7500, 75000, 2000000, NULL, '["Everything in Growth", "Unlimited agents", "Most AI tokens"]', 3)
ON CONFLICT (code) DO NOTHING;

-- One subscription per company. Tokens reset every month (also on yearly plans).
CREATE TABLE IF NOT EXISTS company_subscription (
  company_id          BIGINT PRIMARY KEY,
  package_id          INT NOT NULL,
  billing_cycle       VARCHAR(10) NOT NULL DEFAULT 'monthly',
  status              VARCHAR(20) NOT NULL DEFAULT 'active',
  period_start        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end          TIMESTAMPTZ NULL,
  token_period_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_period_end    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 month'),
  warned_80_at        TIMESTAMPTZ NULL,
  warned_100_at       TIMESTAMPTZ NULL,
  auto_renew          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extra (or removed) tokens given by the super admin, optionally temporary
CREATE TABLE IF NOT EXISTS token_adjustment (
  id                  SERIAL PRIMARY KEY,
  company_id          BIGINT NOT NULL,
  tokens              BIGINT NOT NULL,
  reason              TEXT NOT NULL DEFAULT '',
  expires_at          TIMESTAMPTZ NULL,
  created_by_user_id  BIGINT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_adjustment_company ON token_adjustment (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_ai_usage_company_time ON bot_ai_usage (company_id, created_at);
