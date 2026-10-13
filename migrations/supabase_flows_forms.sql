-- Forms (asked in the chat or filled on a link page) and automation flows (first message / keyword / ad / comment)

CREATE TABLE IF NOT EXISTS chat_form (
  id SERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(40) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  thank_you TEXT NOT NULL DEFAULT 'Thank you! We received your details.',
  add_tags TEXT[] NOT NULL DEFAULT '{}',
  set_stage VARCHAR(20) NULL,
  notify BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_form_company ON chat_form (company_id);

CREATE TABLE IF NOT EXISTS chat_form_submission (
  id SERIAL PRIMARY KEY,
  form_id INT NOT NULL REFERENCES chat_form(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL,
  bot_channel_user_id INT NULL,
  conversation_id INT NULL,
  channel VARCHAR(20) NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'chat',
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_form_submission_form ON chat_form_submission (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_form_submission_user ON chat_form_submission (bot_channel_user_id);

-- one-time links for a customer (so a link answer is tied to the chat it was sent in)
CREATE TABLE IF NOT EXISTS chat_form_invite (
  token VARCHAR(40) PRIMARY KEY,
  form_id INT NOT NULL REFERENCES chat_form(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL,
  bot_channel_user_id INT NULL,
  conversation_id INT NULL,
  channel VARCHAR(20) NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS channels TEXT[] NOT NULL DEFAULT ARRAY['whatsapp','messenger','instagram'];
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS runs INT NOT NULL DEFAULT 0;
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS completed INT NOT NULL DEFAULT 0;
ALTER TABLE automation_flow ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS automation_run (
  id SERIAL PRIMARY KEY,
  flow_id INT NOT NULL REFERENCES automation_flow(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL,
  conversation_id INT NOT NULL,
  bot_channel_user_id INT NULL,
  platform VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  step_index INT NOT NULL DEFAULT 0,
  waiting JSONB NULL,
  vars JSONB NOT NULL DEFAULT '{}'::jsonb,
  resume_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_run_conv ON automation_run (conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_automation_run_resume ON automation_run (resume_at) WHERE status = 'delayed';

-- comment trigger: one DM per comment
CREATE TABLE IF NOT EXISTS automation_comment_reply (
  comment_id VARCHAR(80) PRIMARY KEY,
  flow_id INT NOT NULL,
  company_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
