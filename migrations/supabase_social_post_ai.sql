-- Agent Metra Social: what the AI read from each post (once per post) and the per-post switch for AI comment replies.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

CREATE TABLE IF NOT EXISTS social_post_ai (
  company_id   BIGINT NOT NULL,
  post_id      VARCHAR(80) NOT NULL,
  platform     VARCHAR(12) NOT NULL DEFAULT 'facebook',
  auto_reply   BOOLEAN NOT NULL DEFAULT TRUE,
  kind         VARCHAR(16) NULL,
  summary      TEXT NULL,
  read_at      TIMESTAMPTZ NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, post_id)
);
