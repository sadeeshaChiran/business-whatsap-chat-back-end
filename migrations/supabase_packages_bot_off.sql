-- Package rollout: only Free is active for now. Preserve Free-plan bot preferences across restarts.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT '';

ALTER TABLE companies
  ALTER COLUMN plan SET DEFAULT '';

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE companies
  ALTER COLUMN bot_enabled SET DEFAULT FALSE;

-- Switch the bot off only for companies WITHOUT a valid active package.
-- (Before the platform packages existed, only Free was allowed. Paid packages such as growth / scale
-- are valid now, so their bot must survive restarts.) Runs as a DO block so it also works before
-- the platform_package table exists (first start: old rule).
DO $$
BEGIN
  IF to_regclass('public.platform_package') IS NOT NULL THEN
    UPDATE companies c
       SET bot_enabled = FALSE
     WHERE c.bot_enabled IS DISTINCT FROM FALSE
       AND NOT EXISTS (SELECT 1 FROM platform_package p
                        WHERE p.is_active AND LOWER(p.code) = LOWER(TRIM(COALESCE(c.plan, ''))));
  ELSE
    UPDATE companies
       SET bot_enabled = FALSE
     WHERE LOWER(TRIM(COALESCE(plan, ''))) <> 'free'
       AND bot_enabled IS DISTINCT FROM FALSE;
  END IF;
END $$;

ALTER TABLE bot_channel_user
  ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE bot_channel_user
  ALTER COLUMN bot_enabled SET DEFAULT FALSE;

DO $$
BEGIN
  IF to_regclass('public.platform_package') IS NOT NULL THEN
    UPDATE bot_channel_user u
       SET bot_enabled = FALSE, manual_mode = TRUE
     WHERE u.bot_enabled IS DISTINCT FROM FALSE
       AND u.company_id IN (SELECT c.id FROM companies c
                             WHERE NOT EXISTS (SELECT 1 FROM platform_package p
                                                WHERE p.is_active AND LOWER(p.code) = LOWER(TRIM(COALESCE(c.plan, '')))));
  ELSE
    UPDATE bot_channel_user
       SET bot_enabled = FALSE, manual_mode = TRUE
     WHERE company_id IN (SELECT id FROM companies WHERE LOWER(TRIM(COALESCE(plan, ''))) <> 'free')
       AND bot_enabled IS DISTINCT FROM FALSE;
  END IF;
END $$;