-- Package rollout: only Free is active for now, and bot automation is disabled globally.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT '';

ALTER TABLE companies
  ALTER COLUMN plan SET DEFAULT '';

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE companies
  ALTER COLUMN bot_enabled SET DEFAULT FALSE;

UPDATE companies
SET bot_enabled = FALSE
WHERE bot_enabled IS DISTINCT FROM FALSE;

ALTER TABLE bot_channel_user
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE bot_channel_user
  ALTER COLUMN bot_enabled SET DEFAULT FALSE;

UPDATE bot_channel_user
SET bot_enabled = FALSE,
    manual_mode = TRUE
WHERE bot_enabled IS DISTINCT FROM FALSE;