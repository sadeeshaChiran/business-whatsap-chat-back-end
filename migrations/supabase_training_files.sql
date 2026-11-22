-- AI knowledge entries can carry files (photo, MP4 video, PDF) the bot sends to customers.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_training_data ADD COLUMN IF NOT EXISTS files JSONB NOT NULL DEFAULT '[]'::jsonb;
