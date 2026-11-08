-- Inbox privacy and agents per WhatsApp number. Runs at startup. Safe to run many times.
-- No semicolons or quotes inside comments.

-- Settings - Inbox privacy: hide the message text of a channel in the inbox (chat list, notes, orders and the bot keep working)
CREATE TABLE IF NOT EXISTS company_message_privacy (
  company_id      BIGINT PRIMARY KEY,
  hide_whatsapp   BOOLEAN NOT NULL DEFAULT FALSE,
  hide_messenger  BOOLEAN NOT NULL DEFAULT FALSE,
  hide_instagram  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Channels - WhatsApp numbers: only these agents get the chats of this number (empty = every agent, as before)
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS agent_ids BIGINT[] NULL;

-- Channels - WhatsApp: number connected from the WhatsApp Business app (coexistence - the phone app keeps working)
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS coexistence BOOLEAN NOT NULL DEFAULT FALSE;
