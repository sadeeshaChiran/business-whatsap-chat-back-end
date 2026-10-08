-- Sales bot follow-ups: customers who showed interest but did not order get up to 2 friendly follow-up messages.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_status VARCHAR(20) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_interest VARCHAR(12) NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_note TEXT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_due_at TIMESTAMPTZ NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_count INT NOT NULL DEFAULT 0;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_last_at TIMESTAMPTZ NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_total INT NOT NULL DEFAULT 0;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS followup_quiet_since TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_bot_conversation_followup_due ON bot_conversation (followup_due_at) WHERE followup_due_at IS NOT NULL;
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS followup_first_hours NUMERIC(5,2) NOT NULL DEFAULT 3;
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS followup_second_hours NUMERIC(5,2) NOT NULL DEFAULT 22;
