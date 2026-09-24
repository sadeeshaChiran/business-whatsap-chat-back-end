CREATE TABLE IF NOT EXISTS automation_flow (
  id serial PRIMARY KEY,
  company_id bigint NOT NULL,
  name varchar(255) NOT NULL,
  description text NOT NULL DEFAULT '',
  trigger_type varchar(50) NOT NULL DEFAULT 'new_message',
  status varchar(20) NOT NULL DEFAULT 'draft',
  definition jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_flow_company
  ON automation_flow (company_id, updated_at DESC);
