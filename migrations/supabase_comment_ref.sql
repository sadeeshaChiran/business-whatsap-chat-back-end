-- The Facebook / Instagram comment a chat started from (private reply), so the sales bot knows the post. Runs at startup. Safe to run many times.
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS comment_ref VARCHAR(120);
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS comment_ref_at TIMESTAMPTZ;
