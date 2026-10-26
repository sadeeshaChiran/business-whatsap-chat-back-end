-- Telegram part 2 (Oct 2026): Telegram groups and channels, only for the customers it lets in.
-- The business makes the group / channel in Telegram and adds its bot as an admin – the bot then lets in only the people the
-- business invited (join requests of others are declined) and can remove people again.
CREATE TABLE IF NOT EXISTS telegram_space (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  connection_id        BIGINT NOT NULL,
  chat_id              TEXT NOT NULL,
  type                 VARCHAR(12) NOT NULL,
  title                TEXT NULL,
  username             TEXT NULL,
  bot_status           VARCHAR(20) NOT NULL DEFAULT 'administrator',
  can_invite           BOOLEAN NOT NULL DEFAULT FALSE,
  can_restrict         BOOLEAN NOT NULL DEFAULT FALSE,
  can_post             BOOLEAN NOT NULL DEFAULT FALSE,
  members_only         BOOLEAN NOT NULL DEFAULT TRUE,
  audience_tags        TEXT[] NOT NULL DEFAULT '{}',
  invite_link          TEXT NULL,
  member_count         INT NULL,
  invite_status        VARCHAR(12) NULL,
  invite_total         INT NOT NULL DEFAULT 0,
  invite_sent          INT NOT NULL DEFAULT 0,
  invite_failed        INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_space_chat ON telegram_space (connection_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_telegram_space_company ON telegram_space (company_id);

-- who may be in a space: invited → joined → left / removed (declined = asked without an invite)
CREATE TABLE IF NOT EXISTS telegram_space_access (
  space_id             BIGINT NOT NULL,
  channel_user_id      BIGINT NOT NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'invited',
  invited_at           TIMESTAMPTZ NULL,
  joined_at            TIMESTAMPTZ NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (space_id, channel_user_id)
);
