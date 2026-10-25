-- What each person wants as phone / browser notifications (Oct 2026).
-- No row = the old behaviour: every message and every alert, and the browser mode all or needs a person.
CREATE TABLE IF NOT EXISTS notification_preference (
  user_id BIGINT PRIMARY KEY,
  company_id BIGINT NOT NULL,
  -- customer messages: all = every message, attention = only chats that need a person, off = none
  messages VARCHAR(12) NOT NULL DEFAULT 'all',
  orders BOOLEAN NOT NULL DEFAULT TRUE,
  order_changes BOOLEAN NOT NULL DEFAULT TRUE,
  handoffs BOOLEAN NOT NULL DEFAULT TRUE,
  bookings BOOLEAN NOT NULL DEFAULT TRUE,
  stock BOOLEAN NOT NULL DEFAULT TRUE,
  -- quiet hours (Sri Lanka time): only chats that need a person still notify
  quiet_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_start VARCHAR(5) NOT NULL DEFAULT '22:00',
  quiet_end VARCHAR(5) NOT NULL DEFAULT '07:00',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_preference_company ON notification_preference (company_id);
