-- Customer app part 4 (Oct 2026): member roles and who-can-message-whom rules, online / last seen,
-- group chats in the Inbox, read counts in groups.

-- roles the business gives to people on its app list (e.g. teacher, parent, vip)
ALTER TABLE ca_app_member ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_ca_app_member_roles ON ca_app_member USING GIN (roles);

-- member messages: off / groups (members of the same group that shows its member list) / roles (only the role pairs allowed)
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS dm_mode VARCHAR(10) NOT NULL DEFAULT 'groups';
-- e.g. [[parent,teacher],[vip,vip]] – a pair works both ways, a star = anyone on the list
ALTER TABLE ca_settings ADD COLUMN IF NOT EXISTS dm_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

-- online / last seen (customers can hide their last seen – then they can not see others either)
ALTER TABLE ca_account ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NULL;
ALTER TABLE ca_account ADD COLUMN IF NOT EXISTS show_last_seen BOOLEAN NOT NULL DEFAULT TRUE;

-- a group message copied into the business Inbox (and Inbox replies copied into the group)
ALTER TABLE ca_group_message ADD COLUMN IF NOT EXISTS bot_message_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_ca_group_message_bot ON ca_group_message (bot_message_id) WHERE bot_message_id IS NOT NULL;
