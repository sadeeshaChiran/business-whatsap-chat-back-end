-- More than one WhatsApp number per company (Oct 2026).
-- Every number is a row in whatsapp_channels. The main number (is_primary) is the one the company had before;
-- nothing changes for companies with one number. Customers are answered from the number they wrote to.

ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS label TEXT;
-- what the number is for: sales / support / wholesale / ads / delivery / other
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS purpose VARCHAR(30);
-- extra instructions for the AI bot on this number (e.g. wholesale customers: minimum 10 packs)
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS bot_note TEXT;
-- false = the AI bot does not answer on this number (the team answers)
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS display_phone VARCHAR(40);
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS verified_name TEXT;

-- the number each company already has becomes its main number
UPDATE whatsapp_channels w SET is_primary = TRUE
 WHERE w.id = (SELECT MIN(x.id) FROM whatsapp_channels x WHERE x.company_id = w.company_id)
   AND NOT EXISTS (SELECT 1 FROM whatsapp_channels y WHERE y.company_id = w.company_id AND y.is_primary);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_company ON whatsapp_channels (company_id);

-- which number the customer wrote to last (replies go from it) and which number brought them first
ALTER TABLE bot_channel_user ADD COLUMN IF NOT EXISTS whatsapp_channel_id INTEGER;
ALTER TABLE bot_channel_user ADD COLUMN IF NOT EXISTS first_whatsapp_channel_id INTEGER;
-- the number an inbound message arrived on / an order was placed through
ALTER TABLE bot_message ADD COLUMN IF NOT EXISTS whatsapp_channel_id INTEGER;
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS whatsapp_channel_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_bot_channel_user_wa_channel ON bot_channel_user (company_id, whatsapp_channel_id) WHERE whatsapp_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_order_wa_channel ON bot_order (company_id, whatsapp_channel_id) WHERE whatsapp_channel_id IS NOT NULL;

-- an order takes the number the customer is using when it is created (bot, team and admin orders alike)
CREATE OR REPLACE FUNCTION bot_order_set_whatsapp_channel() RETURNS trigger AS $$
BEGIN
  IF NEW.whatsapp_channel_id IS NULL AND NEW.bot_channel_user_id IS NOT NULL THEN
    SELECT cu.whatsapp_channel_id INTO NEW.whatsapp_channel_id
      FROM bot_channel_user cu WHERE cu.id = NEW.bot_channel_user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bot_order_whatsapp_channel ON bot_order;
CREATE TRIGGER trg_bot_order_whatsapp_channel BEFORE INSERT ON bot_order
  FOR EACH ROW EXECUTE FUNCTION bot_order_set_whatsapp_channel();
