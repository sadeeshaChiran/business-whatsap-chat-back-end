ALTER TABLE bot_conversation
  ADD COLUMN IF NOT EXISTS lead_stage varchar(30) NOT NULL DEFAULT 'new';

CREATE INDEX IF NOT EXISTS idx_bot_conversation_company_lead_stage
  ON bot_conversation (lead_stage, updated_at);
