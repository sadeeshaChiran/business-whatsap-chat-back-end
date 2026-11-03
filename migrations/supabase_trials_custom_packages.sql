-- Free trials of paid packages, custom packages for one company, and "AI bot only for the first N days" (Free package).

-- A package made for one company only (never on the pricing page, only that company can renew it)
ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS company_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_package_company ON platform_package (company_id) WHERE company_id IS NOT NULL;

-- AI bot (with the package credits) only for the first N days on this package – afterwards only bought credits. NULL = always.
-- First time: the Free package gets 30 days, and companies already on Free get 30 days from today.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_package' AND column_name = 'bot_days') THEN
    ALTER TABLE platform_package ADD COLUMN bot_days INT NULL;
    UPDATE platform_package SET bot_days = 30 WHERE code = 'free';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'company_subscription' AND column_name = 'bot_free_until') THEN
    ALTER TABLE company_subscription ADD COLUMN bot_free_until TIMESTAMPTZ NULL;
    UPDATE company_subscription s SET bot_free_until = NOW() + INTERVAL '30 days'
      FROM platform_package p WHERE p.id = s.package_id AND p.code = 'free';
  END IF;
END $$;

-- Free trial of a (paid) package: when period_end passes, the company moves to fallback_package_id (Free) instead of "expired"
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS is_trial BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS trial_note VARCHAR(200) NULL;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS fallback_package_id INT NULL;
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS trial_reminded_at TIMESTAMPTZ NULL;

-- every trial given (for the super admin report)
CREATE TABLE IF NOT EXISTS company_trial (
  id           SERIAL PRIMARY KEY,
  company_id   BIGINT NOT NULL,
  package_id   INT NOT NULL,
  days         INT NOT NULL,
  source       VARCHAR(20) NOT NULL DEFAULT 'admin', -- admin | signup
  note         VARCHAR(200) NULL,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ NULL,
  converted    BOOLEAN NOT NULL DEFAULT FALSE,           -- paid for a package before / when the trial ended
  created_by_user_id BIGINT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_trial_company ON company_trial (company_id, created_at DESC);

-- new sign-ups start on Free (not on "no package"), so the first login goes straight into setup
UPDATE companies c SET plan = 'free'
 WHERE COALESCE(c.plan, '') = '' AND EXISTS (SELECT 1 FROM platform_package p WHERE p.code = 'free' AND p.is_active)
   AND c.created_at > NOW() - INTERVAL '2 days';

-- reminder "your free AI bot days end soon" (once)
ALTER TABLE company_subscription ADD COLUMN IF NOT EXISTS bot_free_reminded_at TIMESTAMPTZ NULL;
