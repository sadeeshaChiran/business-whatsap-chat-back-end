ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS assigned_agent_id BIGINT;
