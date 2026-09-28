-- Sales bot (Python AI seller) – tables and columns.
-- Runs at startup (see src/common/run-startup-migrations.ts). Safe to run many times.

-- Per-company bot settings (bot on/off itself stays in companies.bot_enabled)
CREATE TABLE IF NOT EXISTS bot_sales_settings (
  company_id                 BIGINT PRIMARY KEY,
  bot_name                   VARCHAR(100) NOT NULL DEFAULT '',
  tone                       VARCHAR(255) NOT NULL DEFAULT 'friendly, short, helpful',
  default_language           VARCHAR(30)  NOT NULL DEFAULT 'auto',
  greeting                   TEXT NOT NULL DEFAULT '',
  about                      TEXT NOT NULL DEFAULT '',
  opening_hours              VARCHAR(255) NOT NULL DEFAULT '',
  payment_methods            VARCHAR(255) NOT NULL DEFAULT '',
  -- new customers get the bot automatically (unless an agent switched it off for them)
  auto_enable_new_customers  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Services customers can book (salon, clinic, classes, rooms…)
CREATE TABLE IF NOT EXISTS bot_service (
  id            SERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  name          VARCHAR(255) NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_note    VARCHAR(50) NOT NULL DEFAULT '',
  duration_min  INT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_service_company ON bot_service (company_id);

-- Delivery fee per area ("*" = everywhere else)
CREATE TABLE IF NOT EXISTS bot_delivery_zone (
  id          SERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL,
  area        VARCHAR(120) NOT NULL,
  fee         NUMERIC(12,2) NOT NULL DEFAULT 0,
  days        VARCHAR(120) NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_delivery_zone_area ON bot_delivery_zone (company_id, LOWER(TRIM(area)));

-- Bookings collected by the bot
CREATE TABLE IF NOT EXISTS bot_booking (
  id                   SERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  bot_channel_user_id  INT NULL,
  conversation_id      INT NULL,
  service_id           INT NULL,
  service_name         VARCHAR(255) NOT NULL,
  date                 VARCHAR(40) NOT NULL DEFAULT '',
  time                 VARCHAR(40) NOT NULL DEFAULT '',
  customer_name        VARCHAR(255) NOT NULL DEFAULT '',
  customer_phone       VARCHAR(50) NULL,
  notes                TEXT NOT NULL DEFAULT '',
  status               VARCHAR(20) NOT NULL DEFAULT 'requested',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_booking_company ON bot_booking (company_id, created_at DESC);

-- One row per bot reply: tokens, cost and speed (for reports)
CREATE TABLE IF NOT EXISTS bot_ai_usage (
  id               SERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL,
  conversation_id  INT NULL,
  model            VARCHAR(100) NOT NULL DEFAULT '',
  input_tokens     INT NOT NULL DEFAULT 0,
  cached_tokens    INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL DEFAULT 0,
  calls            INT NOT NULL DEFAULT 1,
  cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  latency_ms       INT NOT NULL DEFAULT 0,
  is_test          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_ai_usage_company ON bot_ai_usage (company_id, created_at DESC);

-- Why a chat is waiting in the unassigned queue (bot_handoff / order_check / bot_error)
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS queue_reason VARCHAR(30) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS queue_note TEXT NULL;

-- Orders from the bot keep their delivery fee and payment method
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12,2) NULL;
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS payment_method VARCHAR(60) NULL;
