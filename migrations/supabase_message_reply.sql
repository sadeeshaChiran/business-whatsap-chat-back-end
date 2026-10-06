-- Quoted replies: the customer (or an agent) replies to one earlier message.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS reply_to_message_id INT NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS reply_to_provider_id VARCHAR(160) NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS reply_to_text TEXT NULL;
