-- AI cost detail: thinking tokens (part of output, billed at the output price) and the lookups that caused extra calls.
ALTER TABLE bot_ai_usage ADD COLUMN IF NOT EXISTS thinking_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_ai_usage ADD COLUMN IF NOT EXISTS tools_used VARCHAR(300) NOT NULL DEFAULT '';
