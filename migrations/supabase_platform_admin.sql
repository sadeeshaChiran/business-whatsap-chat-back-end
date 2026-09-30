-- Agent Metra super admin: audit log and announcements. Runs at startup. Safe to run many times.

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id           SERIAL PRIMARY KEY,
  user_id      BIGINT NULL,
  user_email   VARCHAR(255) NULL,
  action       VARCHAR(120) NOT NULL,
  target       VARCHAR(255) NOT NULL DEFAULT '',
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_time ON platform_audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS platform_announcement (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  message      TEXT NOT NULL,
  priority     VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  company_ids  JSONB NULL,
  recipients   INT NOT NULL DEFAULT 0,
  created_by   BIGINT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
