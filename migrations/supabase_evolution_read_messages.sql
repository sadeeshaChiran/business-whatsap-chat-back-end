ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS evolution_read_messages BOOLEAN;
