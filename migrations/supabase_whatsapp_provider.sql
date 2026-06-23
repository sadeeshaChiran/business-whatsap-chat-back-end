ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS provider_type VARCHAR(20) DEFAULT 'evolution';
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS meta_phone_number_id VARCHAR(64);
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS meta_access_token TEXT;
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS meta_waba_id VARCHAR(64);
ALTER TABLE whatsapp_channels ADD COLUMN IF NOT EXISTS evolution_api_base TEXT;
