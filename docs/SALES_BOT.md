# Sales bot (Python) – backend integration

The Python sales bot replaces the n8n AI workflow for **WhatsApp**.
It is switched on only when `SALES_BOT_URL` is set – without it, everything works exactly as before (n8n).

## How it works

```
WhatsApp (Meta) ─► WhatsappService.processNormalizedInbound
                    ├─ saves the message + agent routing   (unchanged)
                    └─ SalesBotHook ─► SalesBotEngineService
                                        ├─ waits SALES_BOT_DEBOUNCE_MS (quick messages → one reply)
                                        ├─ builds the business "context" (products, variants, prices,
                                        │  services, delivery zones, AI Assistant knowledge, last order)
                                        ├─ POST {SALES_BOT_URL}/reply  (Python + Gemini)
                                        ├─ saves order / booking / lead / handoff
                                        └─ sends photos + reply with the existing Meta/Evolution adapter
```

**When the bot replies** (same rules as the existing bot toggle):
- company plan is Free and `companies.bot_enabled = true` (Sales bot → Settings), and
- the customer has the bot on (`bot_channel_user.bot_enabled`). New customers get it automatically
  (`auto_enable_new_customers`, default on) unless an agent switched it off (`manual_mode`), and
- the chat is not `active` (an agent accepted it) or `closed`.

**Orders:** prices always come from the `product` table (variant price → `variant_price_match` →
product price). The AI's prices are ignored. The delivery fee must exist in `bot_delivery_zone`.
An order is saved only when the customer agrees **after** the summary was shown; otherwise the customer
gets "our team is checking your order" and the chat goes to the queue with reason `order_check`.

**Handoff:** the bot switches itself off for that customer (`manual_mode = true`), sets
`bot_conversation.queue_reason / queue_note`, and routes the chat with the existing agent routing.
Turning the bot back on for the customer (existing toggle) clears the reason.

**AI Assistant knowledge** (`bot_training_data.category`): `Policy` → always in the prompt,
`Style` → reply examples (8 most similar per message), anything else → FAQ search.

## Setup

1. Deploy the Python sales bot (separate service, `sales-bot-python`), with `BOT_API_KEY` and `GEMINI_API_KEY`.
   `DATABASE_URL` is **not** needed – this backend sends the data with each request.
2. In this backend's `.env`:
   ```
   SALES_BOT_URL=http://<python-bot-host>:8000
   SALES_BOT_API_KEY=<same as BOT_API_KEY in the Python bot>
   SALES_BOT_TEST_MODE=false        # true only to use the dashboard's Customer simulator
   ```
3. Restart. The migration `migrations/supabase_sales_bot.sql` runs automatically at startup
   (added to `src/common/run-startup-migrations.ts`). Look for `[migrations] applied supabase_sales_bot.sql`
   and `Python sales bot active at …` in the log.
4. In the dashboard: Sales bot → Settings → switch the bot on, fill in About / hours / payment,
   add Delivery zones (product shops) or Services (service businesses).

## Database (auto-migration)

| Table / column | Purpose |
|---|---|
| `bot_sales_settings` | per-company bot settings (name, tone, language, greeting, about, hours, payment, auto-enable) |
| `bot_service` | services customers can book |
| `bot_delivery_zone` | delivery fee per area (`*` = everywhere else) |
| `bot_booking` | bookings collected by the bot |
| `bot_ai_usage` | tokens / cost / speed per bot reply (reports) |
| `bot_conversation.queue_reason`, `queue_note` | why the chat waits in the unassigned queue |
| `bot_order.delivery_fee`, `payment_method` | set on bot orders (fee is included in `total_amount`) |

Bot messages are saved in `bot_message` with `source = 'sales_bot'` and `intent`
(`order`, `booking`, `lead`, `handoff`, or several, e.g. `lead,handoff`).

## Endpoints (all admin-only, JWT)

`/bot/services`, `/bot/delivery-zones`, `/bot/bookings`, `/bot/sales-bot/settings`,
`/bot/sales-bot/test`, `/bot/sales-bot/simulate` (+ `/status`, `/conversation`),
`/bot/sales-bot/replies`, `/bot/sales-bot/reports` – contract in the frontend's `docs/SALES_BOT_API.md`.
The unassigned queue (`/bot/conversations/unassigned`) now also returns `queue_reason`
`bot_handoff | order_check | bot_error` and `queue_note`.

## Files

New: `src/sales-bot/*`, `src/common/sales-bot-hook.ts`, `migrations/supabase_sales_bot.sql`.
Changed (small, marked with comments): `app.module.ts`, `integrations/whatsapp/whatsapp.service.ts`
(hand inbound to the sales bot; n8n forward only when the sales bot is off),
`agent-routing/agent-routing.service.ts` (queue reason), `bot-admin/bot-admin.service.ts`
(toggle clears the reason), `bot-conversation.entity.ts` and `bot-order.entity.ts` (new columns),
`common/run-startup-migrations.ts`, `.env.example`.

---

## Things noticed in the existing code (NOT changed – for your review)

1. **`src/products/products.service.spec.ts`** has 2 TypeScript errors (`'groups' is of type 'unknown'`).
   The production build excludes spec files, so the app builds; only the test run is affected.
2. **`BotConversation.lead_stage`** has two `@Column` decorators (a `bigint` one above the `varchar` one).
   It works, but it is confusing and can cause wrong types if the schema is ever generated from the entities.
3. **New customers are created with `bot_enabled = false`** (agent-routing, auth, meta messages).
   The sales bot handles this with the `auto_enable_new_customers` setting, but the dashboard's
   "Bot/Manual" badge shows "Manual" until the bot's first reply.
4. **Every inbound chat is routed to an agent (`pending`) even when the bot is on.** The bot keeps
   replying until the agent accepts (`active`). If you want agents to see only handed-over chats,
   the routing needs a change – not done here.
5. **Messenger / Instagram** inbound (`meta-messages.controller.ts`) is not connected to the sales bot –
   WhatsApp only.
6. **The reply wait (debounce) is in memory.** Fine for one backend instance; with several instances
   (PM2 cluster) use sticky routing per company or move it to a Redis queue.
7. **`.env.example` contains real-looking keys** (Pusher secret, Evolution API key, chat media secret).
   If they are real, rotate them and replace them with placeholders.
8. **`app.enableCors()`** allows every origin. Consider limiting it to the dashboard's domain.
9. `EVOLUTION_WEBHOOK_URL` / `N8N_*` settings are still in `.env.example`; when the n8n workflow is retired
   they can be removed (the code keeps working without them).
