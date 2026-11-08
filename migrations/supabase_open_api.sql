-- Agent Metra Shop API: API keys, the webhook of each company and what was already sent to it.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

CREATE TABLE IF NOT EXISTS company_api_key (
  id            SERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  user_id       INT NULL,
  name          VARCHAR(80) NOT NULL DEFAULT 'API key',
  prefix        VARCHAR(20) NOT NULL,
  key_hash      CHAR(64) NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NULL,
  revoked_at    TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS company_api_key_company_idx ON company_api_key (company_id);

CREATE TABLE IF NOT EXISTS company_webhook (
  company_id     BIGINT PRIMARY KEY,
  url            TEXT NULL,
  secret         VARCHAR(80) NOT NULL,
  events         TEXT[] NOT NULL DEFAULT ARRAY['order.created','order.status_changed','booking.created','booking.status_changed'],
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_since  TIMESTAMPTZ NULL,
  last_status    INT NULL,
  last_error     TEXT NULL,
  last_at        TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS open_api_sent (
  company_id   BIGINT NOT NULL,
  kind         VARCHAR(10) NOT NULL,
  ref_id       INT NOT NULL,
  sent_status  VARCHAR(20) NULL,
  attempts     INT NOT NULL DEFAULT 0,
  next_at      TIMESTAMPTZ NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, kind, ref_id)
);
