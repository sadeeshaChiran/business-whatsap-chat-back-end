-- Customer simulator chats made before test numbers existed used normal looking 9477 numbers.
-- Give them a 999 prefix so an agent reply, invoice or broadcast can never reach a real person.
-- Only customers whose chat has simulator messages (provider id sim-...) are changed. Safe to run many times.
UPDATE customers c
   SET customer_phone = '999' || regexp_replace(c.customer_phone, '[^0-9]', '', 'g')
 WHERE regexp_replace(COALESCE(c.customer_phone, ''), '[^0-9]', '', 'g') NOT LIKE '999%'
   AND EXISTS (
     SELECT 1 FROM bot_channel_user u
       JOIN bot_conversation v ON v.bot_channel_user_id = u.id
       JOIN bot_message m ON m.conversation_id = v.id
      WHERE u.company_id = c.company_id AND u.platform = 'whatsapp'
        AND u.external_user_id = regexp_replace(c.customer_phone, '[^0-9]', '', 'g')
        AND m.provider_message_id LIKE 'sim-%');

UPDATE bot_channel_user u
   SET external_user_id = '999' || u.external_user_id
 WHERE u.platform = 'whatsapp' AND u.external_user_id NOT LIKE '999%'
   AND EXISTS (
     SELECT 1 FROM bot_conversation v
       JOIN bot_message m ON m.conversation_id = v.id
      WHERE v.bot_channel_user_id = u.id AND m.provider_message_id LIKE 'sim-%');
