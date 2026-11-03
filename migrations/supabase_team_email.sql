-- Team emails (Oct 2026): an email belongs to the account that CONFIRMED it. Agents and supervisors confirm their email
-- with a code at their first login, so an admin typing a wrong or made-up email does not lock that email for its real owner.
-- the old rule (one account per email, confirmed or not) goes
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS uq_app_user_email;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS "UQ_users_email";
DROP INDEX IF EXISTS uq_app_user_email_lower;
-- owners confirmed their email at sign-up (older owners and super admins count as confirmed too)
UPDATE app_user u SET email_verified_at = COALESCE(u.email_verified_at, u.created_at, NOW())
  FROM companies c WHERE c.admin_user_id = u.id AND u.email_verified_at IS NULL;
UPDATE app_user SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE is_super_admin = TRUE;
-- one confirmed account per email, and never the same email twice inside one company
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_verified_email ON app_user (LOWER(email)) WHERE email_verified_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_company_email ON app_user (company_id, LOWER(email));
