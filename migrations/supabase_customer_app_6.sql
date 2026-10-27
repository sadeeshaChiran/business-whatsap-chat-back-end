-- Customer app part 4C (Oct 2026): voice / video calls and meetings (LiveKit).
-- a call: customer <-> business team, or member <-> member (same rules as member messages)
CREATE TABLE IF NOT EXISTS ca_call (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  scope                VARCHAR(10) NOT NULL,
  dm_id                BIGINT NULL,
  account_id           BIGINT NULL,
  caller_account_id    BIGINT NULL,
  caller_user_id       BIGINT NULL,
  callee_account_id    BIGINT NULL,
  video                BOOLEAN NOT NULL DEFAULT FALSE,
  room                 TEXT NOT NULL,
  status               VARCHAR(12) NOT NULL DEFAULT 'ringing',
  answered_by_user_id  BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at          TIMESTAMPTZ NULL,
  ended_at             TIMESTAMPTZ NULL,
  e2ee                 JSONB NULL
);
ALTER TABLE ca_call ADD COLUMN IF NOT EXISTS e2ee JSONB NULL;
CREATE INDEX IF NOT EXISTS idx_ca_call_company ON ca_call (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_call_callee ON ca_call (callee_account_id) WHERE status = 'ringing';

-- who may start meetings: the business team, plus people with these roles
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS meeting_host_roles TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS ca_meeting (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  title                TEXT NOT NULL,
  starts_at            TIMESTAMPTZ NOT NULL,
  minutes              INT NOT NULL DEFAULT 60,
  room                 TEXT NOT NULL,
  code                 TEXT NOT NULL,
  host_user_id         BIGINT NULL,
  host_account_id      BIGINT NULL,
  audience             JSONB NOT NULL DEFAULT '{}'::jsonb,
  cancelled_at         TIMESTAMPTZ NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_meeting_code ON ca_meeting (code);
CREATE INDEX IF NOT EXISTS idx_ca_meeting_company ON ca_meeting (company_id, starts_at DESC);
