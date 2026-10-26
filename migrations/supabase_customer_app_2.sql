-- Customer app part 2 (Oct 2026): business profile, news, groups, customer profile settings
CREATE TABLE IF NOT EXISTS ca_business_profile (
  company_id           BIGINT PRIMARY KEY,
  logo_key             TEXT NULL,
  about                TEXT NULL,
  address              TEXT NULL,
  phone                TEXT NULL,
  hours                TEXT NULL,
  website              TEXT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ca_account ADD COLUMN IF NOT EXISTS avatar_key TEXT NULL;
ALTER TABLE ca_account ADD COLUMN IF NOT EXISTS show_name BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS ca_news (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  title                TEXT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  media_key            TEXT NULL,
  pinned               BOOLEAN NOT NULL DEFAULT FALSE,
  created_by           BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_news_company ON ca_news (company_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ca_news_view (
  news_id              BIGINT NOT NULL,
  account_id           BIGINT NOT NULL,
  seen_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (news_id, account_id)
);

CREATE TABLE IF NOT EXISTS ca_group (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NULL,
  visibility           VARCHAR(10) NOT NULL DEFAULT 'private',
  mode                 VARCHAR(12) NOT NULL DEFAULT 'announce',
  show_members         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by           BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at          TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_group_company ON ca_group (company_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS ca_group_member (
  group_id             BIGINT NOT NULL,
  account_id           BIGINT NOT NULL,
  role                 VARCHAR(10) NOT NULL DEFAULT 'member',
  muted                BOOLEAN NOT NULL DEFAULT FALSE,
  last_read_id         BIGINT NOT NULL DEFAULT 0,
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_ca_group_member_account ON ca_group_member (account_id);

CREATE TABLE IF NOT EXISTS ca_group_message (
  id                   BIGSERIAL PRIMARY KEY,
  group_id             BIGINT NOT NULL,
  sender_account_id    BIGINT NULL,
  sender_user_id       BIGINT NULL,
  type                 VARCHAR(10) NOT NULL DEFAULT 'text',
  text                 TEXT NOT NULL DEFAULT '',
  media_key            TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_group_message_group ON ca_group_message (group_id, id DESC);

-- customer: notifications of one business on / off (used by phone notifications)
CREATE TABLE IF NOT EXISTS ca_business_mute (
  account_id           BIGINT NOT NULL,
  company_id           BIGINT NOT NULL,
  PRIMARY KEY (account_id, company_id)
);

-- people the business removed from a group can not join it again by themselves
CREATE TABLE IF NOT EXISTS ca_group_removed (
  group_id             BIGINT NOT NULL,
  account_id           BIGINT NOT NULL,
  removed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, account_id)
);
