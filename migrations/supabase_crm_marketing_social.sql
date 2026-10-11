-- CRM tasks priority and type, stage for contacts without a chat, social drafts and saved replies.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

ALTER TABLE crm_task ADD COLUMN IF NOT EXISTS priority VARCHAR(8) NOT NULL DEFAULT 'normal';
ALTER TABLE crm_task ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'follow_up';
CREATE INDEX IF NOT EXISTS idx_crm_task_assigned ON crm_task (company_id, assigned_user_id, status);

ALTER TABLE crm_contact ADD COLUMN IF NOT EXISTS stage VARCHAR(20) NULL;

ALTER TABLE social_post_schedule ALTER COLUMN scheduled_at DROP NOT NULL;
ALTER TABLE social_post_schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS social_saved_reply (
  id          SERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL,
  kind        VARCHAR(10) NOT NULL DEFAULT 'reply',
  title       VARCHAR(80) NOT NULL,
  text        TEXT NOT NULL,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_saved_reply ON social_saved_reply (company_id, kind);
