ALTER TABLE whatsapp_channels
ADD COLUMN IF NOT EXISTS meta_webhook_base_url TEXT;
