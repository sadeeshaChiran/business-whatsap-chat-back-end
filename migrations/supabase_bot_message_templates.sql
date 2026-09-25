CREATE TABLE IF NOT EXISTS bot_message_template (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  title VARCHAR(160) NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  image_url TEXT,
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
  platforms JSONB NOT NULL DEFAULT '["messenger", "instagram"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bot_message_template_company_name UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_bot_message_template_company ON bot_message_template(company_id);
