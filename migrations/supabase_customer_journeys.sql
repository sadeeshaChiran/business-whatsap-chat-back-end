-- Customer journeys: every lead stage change is kept (who became won / lost / interested and WHEN),
-- so results can be counted per visit and per ad click instead of only the current stage.

CREATE TABLE IF NOT EXISTS lead_stage_event (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  bot_channel_user_id BIGINT,
  from_stage VARCHAR(30),
  to_stage VARCHAR(30) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_event_user ON lead_stage_event (bot_channel_user_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_lead_stage_event_conversation ON lead_stage_event (conversation_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_bot_order_channel_user ON bot_order (bot_channel_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_ad_click_user ON marketing_ad_click (bot_channel_user_id, clicked_at);

CREATE OR REPLACE FUNCTION am_lead_stage_event() RETURNS trigger AS $$
BEGIN
  IF NEW.lead_stage IS DISTINCT FROM OLD.lead_stage AND NEW.lead_stage IS NOT NULL THEN
    INSERT INTO lead_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage)
    VALUES (NEW.id, NEW.bot_channel_user_id, OLD.lead_stage, NEW.lead_stage);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_stage_event ON bot_conversation;
CREATE TRIGGER trg_lead_stage_event AFTER UPDATE OF lead_stage ON bot_conversation
  FOR EACH ROW EXECUTE FUNCTION am_lead_stage_event();

-- one-time start: today's stages of older chats, dated at their last customer message
-- (won only when no order / booking shows it already)
INSERT INTO lead_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage, changed_at)
SELECT c.id, c.bot_channel_user_id, NULL, c.lead_stage,
       COALESCE((SELECT MAX(m.created_at) FROM bot_message m WHERE m.conversation_id = c.id AND m.direction::text = 'inbound'), c.updated_at, NOW())
  FROM bot_conversation c
 WHERE NOT EXISTS (SELECT 1 FROM lead_stage_event)
   AND (c.lead_stage IN ('lost', 'qualified', 'proposal')
        OR (c.lead_stage = 'won'
            AND NOT EXISTS (SELECT 1 FROM bot_order o WHERE o.bot_channel_user_id = c.bot_channel_user_id)
            AND NOT EXISTS (SELECT 1 FROM bot_booking b WHERE b.bot_channel_user_id = c.bot_channel_user_id)));
