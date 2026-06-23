ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_agent_id BIGINT;

ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS assignment_mode VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_bot_conversation_pending_timeout
  ON bot_conversation (status, timeout_at)
  WHERE status = 'pending';
