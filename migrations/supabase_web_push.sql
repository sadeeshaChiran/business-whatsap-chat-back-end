-- Phone / desktop notifications through the browser (Web Push): one row per browser that allowed notifications.
CREATE TABLE IF NOT EXISTS web_push_subscription (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  company_id BIGINT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'all',
  device VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_web_push_subscription_user ON web_push_subscription (user_id);
