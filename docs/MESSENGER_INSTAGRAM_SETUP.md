# Messenger + Instagram for the AI sales bot

WhatsApp, Facebook Messenger and Instagram DMs now use the same sales bot, inbox, orders and agent handoff.

## What changed in the code
- `meta-messages.controller.ts` – every new Messenger / Instagram customer message is handed to the sales bot (before, it was only saved for agents).
- New customers on Messenger / Instagram now follow the same "auto-enable bot for new customers" setting as WhatsApp (before they were forced to manual mode, so the bot never answered).
- `meta-social-sender.service.ts` (new) – sends the bot's text and product photos through the connected Facebook Page (Messenger) or Instagram account.
- `sales-bot-engine.service.ts` – picks WhatsApp vs Messenger vs Instagram per chat. On Messenger/Instagram the chat id is not a phone number, so an order is held for a person unless the customer gave a phone number.
- `meta.controller.ts` + `meta-graph.service.ts` – connecting a Page now also subscribes it to the messaging webhook (without this step Meta sends nothing). If it fails, `messaging_warning` is returned and `last_error` is saved on the connection.

## One-time setup in Meta (developers.facebook.com)
1. Set in `.env`: `META_APP_ID`, `META_APP_SECRET`, `META_MESSAGING_VERIFY_TOKEN`, `SALES_BOT_URL`, `SALES_BOT_API_KEY`, `PUBLIC_API_BASE_URL` (public https address, needed for Instagram photos).
2. App -> Messenger -> Webhooks: callback URL `https://YOUR_API_HOST/v1/api/integrations/meta/messages/webhook`, verify token = `META_MESSAGING_VERIFY_TOKEN`. Subscribe object **Page**: `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads`.
3. Same webhook for object **Instagram**: `messages`.
4. Permissions: `pages_messaging`, `pages_manage_metadata`, `instagram_manage_messages` (+ `instagram_basic`). While the app is in Development mode only people with a role on the app can message the bot; go through App Review + Live mode for real customers.
5. In the dashboard: Settings -> connect the Facebook Page again (this runs the new webhook subscription). The Instagram account must be a Business/Creator account linked to that Page.

## Limits set by Meta
- The bot can only reply within 24 hours of the customer's last message.
- Instagram cannot receive uploaded files: photos are sent as links, so `PUBLIC_API_BASE_URL` / product image URLs must be public.
- One Page per company is used (existing behaviour).
