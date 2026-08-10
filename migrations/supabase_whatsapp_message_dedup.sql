ALTER TABLE bot_message
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_bot_message_provider_message_id
  ON bot_message (platform, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_message_conversation_provider_message
  ON bot_message (conversation_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
