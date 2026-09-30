-- Agent Metra CRM: contact details, tags, deal value, tasks / follow-ups. Runs at startup. Safe to run many times.

CREATE TABLE IF NOT EXISTS crm_contact (
  bot_channel_user_id  INT PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  email                VARCHAR(255) NULL,
  phone                VARCHAR(30) NULL,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  deal_value           NUMERIC(14,2) NULL,
  owner_user_id        BIGINT NULL,
  source               VARCHAR(60) NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_company ON crm_contact (company_id);

CREATE TABLE IF NOT EXISTS crm_task (
  id                   SERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  bot_channel_user_id  INT NULL,
  title                VARCHAR(255) NOT NULL,
  notes                TEXT NOT NULL DEFAULT '',
  due_at               TIMESTAMPTZ NULL,
  assigned_user_id     BIGINT NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'open',
  reminded_at          TIMESTAMPTZ NULL,
  created_by_user_id   BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at              TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_task_company ON crm_task (company_id, status, due_at);
