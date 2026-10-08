-- Owner feedback on sales bot replies (thumbs up / down in the inbox).
-- Up = the reply becomes a style example. Down = the owner gives a better reply, or it is kept as a wrong reply to avoid.
-- Safe to run many times. No semicolons or quotes inside comments.
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS feedback VARCHAR(8) NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS feedback_by INT NULL;
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS feedback_training_id INT NULL;
