-- Business Health Scanner: app tables on Supabase (non-destructive, skips existing).

CREATE TABLE IF NOT EXISTS industry (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_user (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  company_id BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_user_email UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS note_color_tags (
  id SERIAL PRIMARY KEY,
  company_id BIGINT,
  name VARCHAR(100) NOT NULL,
  meaning VARCHAR(255) NOT NULL DEFAULT '',
  color_code VARCHAR(20) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS note (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  created_user_id BIGINT NOT NULL,
  color_tag_id BIGINT NOT NULL,
  is_selected_for_ai BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS income_catergory (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  company_id BIGINT,
  is_common BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS income (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  amount INTEGER NOT NULL,
  note VARCHAR(255) NOT NULL DEFAULT '',
  sourse VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_user_id BIGINT NOT NULL,
  income_category_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses_catergory (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  company_id BIGINT,
  is_common BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expense (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  amount INTEGER NOT NULL,
  note VARCHAR(255) NOT NULL DEFAULT '',
  sourse VARCHAR(20) NOT NULL DEFAULT 'manual',
  created_user_id BIGINT NOT NULL,
  expense_category_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_channel_user (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  app_user_id BIGINT,
  platform VARCHAR(30) NOT NULL,
  external_user_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  language VARCHAR(30) NOT NULL DEFAULT 'English',
  language_locked BOOLEAN NOT NULL DEFAULT FALSE,
  session_state TEXT,
  bot_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manual_mode BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  reminder_24h_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bot_channel_user_platform_external UNIQUE (platform, external_user_id)
);

CREATE TABLE IF NOT EXISTS bot_conversation (
  id SERIAL PRIMARY KEY,
  bot_channel_user_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_message (
  id SERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  direction VARCHAR(20) NOT NULL,
  message_type VARCHAR(20) NOT NULL,
  platform VARCHAR(30) NOT NULL,
  content TEXT NOT NULL,
  media_url TEXT,
  transcript TEXT,
  llm_provider VARCHAR(100),
  llm_model VARCHAR(100),
  intent VARCHAR(255),
  sentiment VARCHAR(50),
  trouble_score DECIMAL(5, 2),
  source VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_training_data (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  language VARCHAR(30) NOT NULL DEFAULT 'English',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  vector_embedding BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_flag (
  id SERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  bot_channel_user_id BIGINT NOT NULL,
  flag_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_order (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  bot_channel_user_id BIGINT NOT NULL,
  customer_name VARCHAR(255) NOT NULL DEFAULT '',
  customer_phone VARCHAR(50) NOT NULL DEFAULT '',
  address TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  invoice_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_order_item (
  id SERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  product_id BIGINT,
  product_name VARCHAR(255) NOT NULL,
  variant_text VARCHAR(255),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_order_status_history (
  id SERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_order_status_template (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  template TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bot_order_status_template_company_status UNIQUE (company_id, status)
);

-- Extend existing Supabase `whatsapp_channels` table (non-destructive).
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS evaluation_whatsapp_key TEXT;
