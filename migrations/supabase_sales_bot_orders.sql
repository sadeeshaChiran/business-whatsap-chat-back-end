-- Sales bot: order changes / cancellations / special notes, invoices, products + services, lead details.
-- Runs at startup (src/common/run-startup-migrations.ts). Safe to run many times.

-- What the business sells: auto (from business category) | products | services | both
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS sells VARCHAR(20) NOT NULL DEFAULT 'auto';
-- Send the invoice PDF automatically when the bot saves an order
ALTER TABLE bot_sales_settings ADD COLUMN IF NOT EXISTS auto_send_invoice BOOLEAN NOT NULL DEFAULT TRUE;

-- Delivery zone of a bot order (the fee is recalculated from it when the order is changed)
ALTER TABLE bot_order ADD COLUMN IF NOT EXISTS delivery_area VARCHAR(120) NULL;

-- What the bot learned about a lead (need, budget, location, order value) for Lead Management
ALTER TABLE bot_conversation ADD COLUMN IF NOT EXISTS lead_details JSONB NULL;

-- Alerts for the team (special notes, order changes, cancellation requests) shown in Notifications
CREATE TABLE IF NOT EXISTS bot_notification (
  id               SERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL,
  kind             VARCHAR(30) NOT NULL,
  priority         VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  title            VARCHAR(255) NOT NULL,
  message          TEXT NOT NULL DEFAULT '',
  conversation_id  INT NULL,
  order_id         INT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_notification_company ON bot_notification (company_id, created_at DESC);
