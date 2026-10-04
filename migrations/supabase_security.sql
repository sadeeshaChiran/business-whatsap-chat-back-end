-- Agent Metra security hardening. Runs at startup. Safe to run many times.
-- (No semicolons or quotes inside comments - the runner splits on them.)

-- token_version: raised on password change, password reset, removed access - old logins stop working
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
-- access_disabled: the company admin removed this agent - login is refused
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS access_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ NULL;

-- Failed logins per email for lockout (15 minutes after 8 wrong passwords)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;

-- Notification read state (was kept in memory and lost on every restart)
CREATE TABLE IF NOT EXISTS user_notification_read (
  user_id          BIGINT NOT NULL,
  notification_key VARCHAR(80) NOT NULL,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_key)
);

-- Speed: lookups used on every request / every inbox refresh
CREATE INDEX IF NOT EXISTS idx_app_user_company ON app_user (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_user_email_lower ON app_user (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_bot_channel_user_company ON bot_channel_user (company_id);
CREATE INDEX IF NOT EXISTS idx_bot_conversation_channel_user ON bot_conversation (bot_channel_user_id);
CREATE INDEX IF NOT EXISTS idx_bot_conversation_agent_status ON bot_conversation (assigned_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_bot_message_conversation_id ON bot_message (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_bot_order_company ON bot_order (company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_bot_notification_company_time ON bot_notification (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_company ON product (company_id);

-- Many queries compare CAST(column AS BIGINT) - these expression indexes let Postgres use an index for them
CREATE INDEX IF NOT EXISTS idx_bot_channel_user_company_big ON bot_channel_user ((CAST(company_id AS BIGINT)));
CREATE INDEX IF NOT EXISTS idx_bot_order_company_big ON bot_order ((CAST(company_id AS BIGINT)), id DESC);
CREATE INDEX IF NOT EXISTS idx_bot_customer_note_company_big ON bot_customer_note ((CAST(company_id AS BIGINT)));
CREATE INDEX IF NOT EXISTS idx_bot_customer_label_company_big ON bot_customer_label ((CAST(company_id AS BIGINT)));
CREATE INDEX IF NOT EXISTS idx_bot_conversation_last_message ON bot_conversation (last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS idx_bot_message_conv_direction ON bot_message (conversation_id, direction, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_conversation_label_conv ON bot_conversation_label (conversation_id);

-- Business types for the company profile
INSERT INTO industry (name, is_active) SELECT v.name, TRUE FROM (VALUES ('General'), ('Fashion and clothing'), ('Electronics'), ('Beauty and health'), ('Food and drinks'), ('Home and living'), ('Education'), ('Services'), ('Travel'), ('Other')) AS v(name) WHERE NOT EXISTS (SELECT 1 FROM industry i WHERE LOWER(i.name) = LOWER(v.name));
