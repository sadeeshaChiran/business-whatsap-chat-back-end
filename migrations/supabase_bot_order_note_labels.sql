ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS admin_note TEXT;

CREATE TABLE IF NOT EXISTS bot_customer_label (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  color_code VARCHAR(32) NOT NULL DEFAULT '#64748b',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bot_customer_label_company_name UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS bot_conversation_label (
  conversation_id BIGINT NOT NULL,
  label_id BIGINT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_customer_label_company
  ON bot_customer_label (company_id);

CREATE INDEX IF NOT EXISTS idx_bot_conversation_label_label
  ON bot_conversation_label (label_id);
