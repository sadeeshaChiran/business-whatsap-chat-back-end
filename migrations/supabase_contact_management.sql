ALTER TABLE bot_channel_user
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS bot_contact_tag (
  company_id bigint NOT NULL,
  channel_user_id bigint NOT NULL REFERENCES bot_channel_user(id) ON DELETE CASCADE,
  label_id bigint NOT NULL REFERENCES bot_customer_label(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_user_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_contact_tag_company
  ON bot_contact_tag (company_id, label_id);
