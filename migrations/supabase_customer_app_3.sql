-- Customer app part 3 (Oct 2026): every business gets its own app (own address, name, logo / home-screen icon),
-- only the numbers the business added can log in, member IDs + member-to-member messages (off by default),
-- block / report, broadcasts (marketing messages) and phone notifications.

-- a phone number written any way → 94771234567 (same as normalizeWhatsapp in the API)
CREATE OR REPLACE FUNCTION ca_norm_phone(value TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN d ~ '^00' THEN substring(d from 3)
    WHEN d ~ '^0\d{9}$' THEN '94' || substring(d from 2)
    WHEN d ~ '^7\d{8}$' THEN '94' || d
    ELSE d END
  FROM (SELECT regexp_replace(COALESCE(value, ''), '\D', '', 'g') AS d) x
$$;

ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS slug TEXT NULL;
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS app_name TEXT NULL;
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS theme_color TEXT NULL;
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS icon_key TEXT NULL;
-- invited = only numbers the business added – link = also anyone who opens the businesss link / QR code
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS access VARCHAR(10) NOT NULL DEFAULT 'invited';
-- members may message each other (in groups that show the member list) – off unless the business turns it on
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS member_dm BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_settings_slug ON ca_settings (slug) WHERE slug IS NOT NULL;

-- the numbers that may use a businesss app
CREATE TABLE IF NOT EXISTS ca_app_member (
  company_id           BIGINT NOT NULL,
  phone                TEXT NOT NULL,
  name                 TEXT NULL,
  source               VARCHAR(20) NOT NULL DEFAULT 'manual',
  added_by             BIGINT NULL,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at            TIMESTAMPTZ NULL,
  last_open_at         TIMESTAMPTZ NULL,
  PRIMARY KEY (company_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_ca_app_member_phone ON ca_app_member (phone);

-- once, when this part is installed: nobody who already chats in the app loses access
-- (only once – a number the business removes later must not come back on the next restart)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_setting WHERE key = 'ca_part3_members_backfill') THEN
    INSERT INTO ca_app_member (company_id, phone, name, source, joined_at, last_open_at)
    SELECT cu.company_id, a.phone, a.name, 'existing', cu.created_at, cu.last_seen_at
      FROM bot_channel_user cu JOIN ca_account a ON cu.external_user_id = 'ca:' || a.id
     WHERE cu.platform = 'app'
    ON CONFLICT DO NOTHING;
    INSERT INTO ca_app_member (company_id, phone, name, source, joined_at)
    SELECT DISTINCT ON (g.company_id, a.phone) g.company_id, a.phone, a.name, 'existing', gm.joined_at
      FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id JOIN ca_account a ON a.id = gm.account_id
    ON CONFLICT DO NOTHING;
    INSERT INTO platform_setting (key, value) VALUES ('ca_part3_members_backfill', '{"done": true}'::jsonb) ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- numbers the business took off its list (with "anyone with the link" they must not come back by themselves)
CREATE TABLE IF NOT EXISTS ca_app_removed (
  company_id           BIGINT NOT NULL,
  phone                TEXT NOT NULL,
  removed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, phone)
);

-- customers: may other members message me?
ALTER TABLE ca_account ADD COLUMN IF NOT EXISTS allow_dm BOOLEAN NOT NULL DEFAULT TRUE;

-- member-to-member chats (inside one businesss app)
CREATE TABLE IF NOT EXISTS ca_dm (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  account_a            BIGINT NOT NULL,
  account_b            BIGINT NOT NULL,
  started_by           BIGINT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at      TIMESTAMPTZ NULL,
  a_last_read_id       BIGINT NOT NULL DEFAULT 0,
  b_last_read_id       BIGINT NOT NULL DEFAULT 0,
  CHECK (account_a < account_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_dm_pair ON ca_dm (company_id, account_a, account_b);
CREATE INDEX IF NOT EXISTS idx_ca_dm_b ON ca_dm (account_b);

CREATE TABLE IF NOT EXISTS ca_dm_message (
  id                   BIGSERIAL PRIMARY KEY,
  dm_id                BIGINT NOT NULL,
  sender_account_id    BIGINT NOT NULL,
  type                 VARCHAR(10) NOT NULL DEFAULT 'text',
  text                 TEXT NOT NULL DEFAULT '',
  media_key            TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_dm_message_dm ON ca_dm_message (dm_id, id DESC);

CREATE TABLE IF NOT EXISTS ca_block (
  account_id           BIGINT NOT NULL,
  blocked_account_id   BIGINT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, blocked_account_id)
);

-- reports go to the business (Channels → Customer app → Reports)
CREATE TABLE IF NOT EXISTS ca_report (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  reporter_account_id  BIGINT NOT NULL,
  target_account_id    BIGINT NULL,
  group_id             BIGINT NULL,
  group_message_id     BIGINT NULL,
  dm_message_id        BIGINT NULL,
  reason               TEXT NOT NULL,
  excerpt              TEXT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ NULL,
  resolved_by          BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_report_company ON ca_report (company_id, created_at DESC);

-- broadcasts: one message from the business into many customers app chats (free)
CREATE TABLE IF NOT EXISTS ca_campaign (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL,
  text                 TEXT NOT NULL DEFAULT '',
  media_key            TEXT NULL,
  audience             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               VARCHAR(12) NOT NULL DEFAULT 'sending',
  total                INT NOT NULL DEFAULT 0,
  sent                 INT NOT NULL DEFAULT 0,
  not_on_app           INT NOT NULL DEFAULT 0,
  last_error           TEXT NULL,
  created_by           BIGINT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at          TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_ca_campaign_company ON ca_campaign (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ca_campaign_recipient (
  campaign_id          BIGINT NOT NULL,
  account_id           BIGINT NOT NULL,
  channel_user_id      BIGINT NULL,
  message_id           BIGINT NULL,
  sent_at              TIMESTAMPTZ NULL,
  PRIMARY KEY (campaign_id, account_id)
);

-- phone notifications (Web Push) of the customer app – company_id = the business app it was turned on in (NULL = the shared /chat app)
CREATE TABLE IF NOT EXISTS ca_push_sub (
  id                   BIGSERIAL PRIMARY KEY,
  account_id           BIGINT NOT NULL,
  company_id           BIGINT NULL,
  endpoint             TEXT NOT NULL,
  p256dh               TEXT NOT NULL,
  auth                 TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at         TIMESTAMPTZ NULL,
  last_error           TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_push_endpoint ON ca_push_sub (endpoint);
CREATE INDEX IF NOT EXISTS idx_ca_push_account ON ca_push_sub (account_id);
