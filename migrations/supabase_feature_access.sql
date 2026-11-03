-- Hidden features (Nov 2026): SMS and the Customer app are hidden from every business,
-- except the ones the Agent Metra team switches on in Super admin - Companies - Hidden features.
CREATE TABLE IF NOT EXISTS company_feature_access (
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature     VARCHAR(30) NOT NULL,
  note        VARCHAR(200) NULL,
  created_by  INTEGER NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, feature)
);
-- one time only: businesses that already use them keep them
INSERT INTO company_feature_access (company_id, feature, note)
SELECT s.company_id, 'customer_app', 'Already used the app' FROM ca_settings s
 WHERE s.enabled AND NOT EXISTS (SELECT 1 FROM platform_setting WHERE key = 'feature_access_seeded')
ON CONFLICT DO NOTHING;
INSERT INTO company_feature_access (company_id, feature, note)
SELECT x.company_id, 'sms', 'Already used SMS' FROM (
  SELECT company_id FROM sms_account
  UNION SELECT company_id FROM sms_wallet WHERE balance > 0
  UNION SELECT DISTINCT company_id FROM sms_message
) x
 WHERE NOT EXISTS (SELECT 1 FROM platform_setting WHERE key = 'feature_access_seeded')
   AND EXISTS (SELECT 1 FROM companies c WHERE c.id = x.company_id)
ON CONFLICT DO NOTHING;
INSERT INTO platform_setting (key, value) VALUES ('feature_access_seeded', '{"at": "2026-11-01"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
