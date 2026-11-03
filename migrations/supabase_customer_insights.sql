-- Customer insights and correct ad results: every lead stage change is kept with its time
-- (so a returning customer who was "won" long ago is not counted as won for a new ad click).

CREATE TABLE IF NOT EXISTS crm_stage_event (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  bot_channel_user_id BIGINT,
  from_stage VARCHAR(30),
  to_stage VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_stage_event_user ON crm_stage_event (bot_channel_user_id, created_at);

CREATE OR REPLACE FUNCTION crm_log_stage_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lead_stage IS NOT NULL AND NEW.lead_stage <> 'new' THEN
      INSERT INTO crm_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage) VALUES (NEW.id, NEW.bot_channel_user_id, NULL, NEW.lead_stage);
    END IF;
  ELSIF NEW.lead_stage IS DISTINCT FROM OLD.lead_stage AND NEW.lead_stage IS NOT NULL THEN
    INSERT INTO crm_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage) VALUES (NEW.id, NEW.bot_channel_user_id, OLD.lead_stage, NEW.lead_stage);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_stage_event ON bot_conversation;
CREATE TRIGGER trg_crm_stage_event AFTER INSERT OR UPDATE OF lead_stage ON bot_conversation
  FOR EACH ROW EXECUTE FUNCTION crm_log_stage_change();

-- fast "visits" (inbound messages per customer over time) and orders / bookings per customer over time
CREATE INDEX IF NOT EXISTS idx_bot_order_channel_user_time ON bot_order (bot_channel_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_booking_channel_user_time ON bot_booking (bot_channel_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_click_user_time ON marketing_ad_click (bot_channel_user_id, clicked_at);
