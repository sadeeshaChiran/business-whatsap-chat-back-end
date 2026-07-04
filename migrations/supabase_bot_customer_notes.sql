CREATE TABLE IF NOT EXISTS bot_customer_note (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  bot_channel_user_id INT NOT NULL,
  content TEXT NOT NULL,
  created_by_user_id BIGINT NULL,
  created_by_name VARCHAR(255) NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_customer_note_company
  ON bot_customer_note (company_id);

CREATE INDEX IF NOT EXISTS idx_bot_customer_note_channel_user
  ON bot_customer_note (bot_channel_user_id);

CREATE INDEX IF NOT EXISTS idx_bot_customer_note_created_at
  ON bot_customer_note (created_at DESC);
