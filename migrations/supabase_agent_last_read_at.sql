ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS agent_last_read_at TIMESTAMPTZ;
