-- Agent Metra package limits: feature switches and numbers per package, editable by the super admin.
-- Runs at startup. Safe to run many times: only packages that have no limits yet get the defaults.
-- No semicolons or quotes inside comments.

ALTER TABLE platform_package ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}';

UPDATE platform_package SET max_products = COALESCE(max_products, 20),
  limits = '{"messenger": false, "instagram": false, "lead_management": false, "crm": false, "marketing_ads": false, "marketing_pro": false, "broadcasts": false, "mobile_app": true, "broadcasts_per_month": 0, "reports_days": 7}'
WHERE code = 'free' AND limits = '{}'::jsonb;

UPDATE platform_package SET max_products = COALESCE(max_products, 200),
  limits = '{"messenger": true, "instagram": true, "lead_management": true, "crm": true, "marketing_ads": true, "marketing_pro": false, "broadcasts": false, "mobile_app": true, "broadcasts_per_month": 0, "reports_days": null}'
WHERE code = 'small' AND limits = '{}'::jsonb;

UPDATE platform_package SET max_products = COALESCE(max_products, 1000),
  limits = '{"messenger": true, "instagram": true, "lead_management": true, "crm": true, "marketing_ads": true, "marketing_pro": true, "broadcasts": true, "mobile_app": true, "broadcasts_per_month": 2000, "reports_days": null}'
WHERE code = 'growth' AND limits = '{}'::jsonb;

UPDATE platform_package SET
  limits = '{"messenger": true, "instagram": true, "lead_management": true, "crm": true, "marketing_ads": true, "marketing_pro": true, "broadcasts": true, "mobile_app": true, "broadcasts_per_month": 10000, "reports_days": null}'
WHERE code = 'scale' AND limits = '{}'::jsonb;
