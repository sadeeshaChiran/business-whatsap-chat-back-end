ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS agent_assignment_timeout_minutes INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN IF NOT EXISTS agent_offline_shift_minutes INTEGER NOT NULL DEFAULT 0;

UPDATE companies
SET
  agent_assignment_timeout_minutes = COALESCE(NULLIF(agent_assignment_timeout_minutes, 0), 1440),
  agent_offline_shift_minutes = GREATEST(COALESCE(agent_offline_shift_minutes, 0), 0);
