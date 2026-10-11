-- Agents: who made each order / booking (bot, agent, admin) and which agent it counts for, who sent each team message,
-- and a separate read time for the admin (an admin reading a chat no longer clears the agent unread count).
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS agent_id INT NULL;
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS created_by VARCHAR(10) NULL;
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS created_by_user_id INT NULL;
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS agent_id INT NULL;
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS created_by VARCHAR(10) NULL;
ALTER TABLE bot_booking ADD COLUMN IF NOT EXISTS created_by_user_id INT NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS sender_user_id INT NULL;
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS admin_last_read_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_bot_order_agent ON bot_order (company_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_bot_booking_agent ON bot_booking (company_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_bot_message_sender ON bot_message (sender_user_id) WHERE sender_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_conversation_agent ON bot_conversation (assigned_agent_id);
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ NULL;
