-- Agent Metra Social: Facebook + Instagram comments, scheduled posts, settings.
-- Runs at startup. Safe to run many times. No semicolons or quotes inside comments.

CREATE TABLE IF NOT EXISTS social_comment (
  id             SERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL,
  platform       VARCHAR(12) NOT NULL,
  comment_id     VARCHAR(80) NOT NULL UNIQUE,
  post_id        VARCHAR(80) NULL,
  parent_id      VARCHAR(80) NULL,
  author_id      VARCHAR(80) NULL,
  author_name    VARCHAR(255) NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  post_text      TEXT NOT NULL DEFAULT '',
  post_link      TEXT NULL,
  created_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status         VARCHAR(10) NOT NULL DEFAULT 'open',
  is_hidden      BOOLEAN NOT NULL DEFAULT FALSE,
  liked          BOOLEAN NOT NULL DEFAULT FALSE,
  our_reply      TEXT NULL,
  reply_id       VARCHAR(80) NULL,
  replied_at     TIMESTAMPTZ NULL,
  replied_by     BIGINT NULL,
  replied_by_ai  BOOLEAN NOT NULL DEFAULT FALSE,
  private_reply  TEXT NULL,
  private_replied_at TIMESTAMPTZ NULL,
  ai_reply       TEXT NULL,
  ai_dm          TEXT NULL,
  ai_intent      VARCHAR(20) NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_comment_company ON social_comment (company_id, status, created_time DESC);

CREATE TABLE IF NOT EXISTS social_post_schedule (
  id            SERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  platforms     TEXT[] NOT NULL DEFAULT '{}',
  message       TEXT NOT NULL DEFAULT '',
  link          TEXT NULL,
  media_urls    JSONB NOT NULL DEFAULT '[]',
  scheduled_at  TIMESTAMPTZ NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'scheduled',
  results       JSONB NOT NULL DEFAULT '{}',
  error         TEXT NULL,
  created_by    BIGINT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_schedule_due ON social_post_schedule (status, scheduled_at);

CREATE TABLE IF NOT EXISTS social_settings (
  company_id    BIGINT PRIMARY KEY,
  auto_reply    VARCHAR(10) NOT NULL DEFAULT 'off',
  auto_dm       BOOLEAN NOT NULL DEFAULT FALSE,
  auto_hide_spam BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at  TIMESTAMPTZ NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- package switch: the Social section is off on Free (super admin can change it)
UPDATE platform_package SET limits = limits || '{"social": false}'::jsonb WHERE code = 'free' AND NOT (limits ? 'social') AND limits <> '{}'::jsonb;
