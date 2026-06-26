-- Preserve Evolution instance name when provider is Meta (Meta routes via meta_phone_number_id).
ALTER TABLE public.whatsapp_channels
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;

-- Backfill alias from existing non-numeric instance names.
UPDATE public.whatsapp_channels
SET evolution_instance_name = instance_name
WHERE evolution_instance_name IS NULL
  AND NULLIF(TRIM(instance_name), '') IS NOT NULL
  AND TRIM(instance_name) !~ '^[0-9]+$';

-- Meta rows: store Evolution alias without changing instance_name (unique constraint safe).
UPDATE public.whatsapp_channels
SET evolution_instance_name = 'chu.lk whatsapp bot'
WHERE company_id = 13
  AND provider_type = 'meta'
  AND NULLIF(TRIM(evolution_instance_name), '') IS NULL;
