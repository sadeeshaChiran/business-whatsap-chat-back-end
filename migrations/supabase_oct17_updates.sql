-- October 17 batch: bot answered marker, manual pipeline stage, product photo notes,
-- auto-accept chats, supervisor role, company activity log. Safe to run more than once.

-- the newest customer message the AI bot has already answered (messages that arrive while it writes are answered next)
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS bot_answered_inbound_id BIGINT;

-- a person picked the pipeline stage by hand – the bot never moves a hand-set Won / Lost
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS lead_stage_manual BOOLEAN NOT NULL DEFAULT FALSE;

-- short AI description of the product photos (colour, pattern, style) so the bot can match customer photos
ALTER TABLE product ADD COLUMN IF NOT EXISTS image_notes TEXT;
ALTER TABLE product ADD COLUMN IF NOT EXISTS image_notes_src TEXT;

-- new chats given to an agent are accepted automatically (the agent can still pass them on)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_auto_accept BOOLEAN NOT NULL DEFAULT TRUE;

-- team role of a staff login: 'agent' or 'supervisor' (team lead). The company owner is company.admin_user_id.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS team_role VARCHAR(20) NOT NULL DEFAULT 'agent';

-- who changed or deleted what (orders etc.) – the owner and supervisors see it under Team → Activity log
CREATE TABLE IF NOT EXISTS company_activity_log (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL,
  user_id BIGINT,
  user_name VARCHAR(255),
  user_role VARCHAR(20),
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id BIGINT,
  summary TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_activity_log_company ON company_activity_log (company_id, created_at DESC);
