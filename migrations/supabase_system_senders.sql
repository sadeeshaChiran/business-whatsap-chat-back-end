-- System messages (Nov 2026): OTP / verification codes and other service messages that other companies send to the
-- business WhatsApp number. system = kept apart for admins only (no agent, no auto reply), normal = an admin said it is a
-- real customer, empty = decided automatically.
ALTER TABLE bot_channel_user ADD COLUMN IF NOT EXISTS system_kind VARCHAR(10) NULL;
CREATE INDEX IF NOT EXISTS idx_bot_channel_user_system ON bot_channel_user (company_id) WHERE system_kind = 'system';
