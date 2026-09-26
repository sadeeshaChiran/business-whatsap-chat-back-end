ALTER TABLE bot_message
ADD COLUMN IF NOT EXISTS delivery_status varchar(20);

CREATE INDEX IF NOT EXISTS idx_bot_message_provider_status
ON bot_message (platform, provider_message_id)
WHERE provider_message_id IS NOT NULL;
