-- Agent Metra verification: email + WhatsApp codes for sign-up and account changes. Runs at startup. Safe to run many times.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ NULL;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(20) NULL;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ NULL;

-- One-time codes (stored as a hash). purpose: register_email, register_whatsapp, change_email, change_whatsapp
CREATE TABLE IF NOT EXISTS verification_code (
  id           SERIAL PRIMARY KEY,
  purpose      VARCHAR(30) NOT NULL,
  reference    VARCHAR(80) NOT NULL,
  target       VARCHAR(255) NOT NULL,
  code_hash    VARCHAR(128) NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verification_code_ref ON verification_code (reference, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_code_target ON verification_code (target, created_at DESC);

-- Sign-ups waiting for both codes (the password is encrypted, the row is deleted when the account is created)
CREATE TABLE IF NOT EXISTS pending_registration (
  id           VARCHAR(40) PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  whatsapp     VARCHAR(20) NOT NULL,
  payload      TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
