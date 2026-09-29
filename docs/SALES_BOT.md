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

**Delivery fee (optional weight rule per zone):** the bot calls its `delivery_fee` lookup and puts the
zone in `order.delivery_area`; the backend then calculates the fee itself:
`fee = base fee + max(0, order kg − included_kg) × per_extra_kg` (exact kg, e.g. 2.4 kg → 1.4 extra kg).
Order kg = Σ (variant weight, else product weight) × quantity. Zones without `included_kg`/`per_extra_kg`
keep a flat fee. The order stores `delivery_fee` and `total_weight_kg`. Products with no weight count as 0 kg
(the bot tells the customer the team may adjust the fee).

**Product data for the bot:** `product.selling_points` (recommendations, price doubts),
`product.related_product_ids` (add-ons – only other products of the same company, max 10),
`product.show_to_bot` (false = never mentioned or sold), variant weight in the variant JSON (`weight`, kg).
Also in the CSV import: `selling_points`, `show_to_bot` (yes/no), `variant_weight`.

**Handoff:** the bot switches itself off for that customer (`manual_mode = true`), sets
`bot_conversation.queue_reason / queue_note`, and routes the chat with the existing agent routing.
Turning the bot back on for the customer (existing toggle) clears the reason.

**AI Assistant knowledge** (`bot_training_data.category`): `Policy` → always in the prompt,
`Style` → reply examples (8 most similar per message), anything else → FAQ search.

## Orders after the sale, notes, invoices, leads (update)

| Customer says | Order status | What happens |
|---|---|---|
| a special request ("deliver quickly", "gift wrap") | – | about an order → dated line in the **order note** (`admin_note`, 📝); otherwise a **customer note**. A note said before the order is saved is added when it is saved. Notification. |
| add / remove / change items, address | **Pending** | the bot **edits the order**: items re-priced from `product`, delivery fee recalculated (zone + weight), ✏️ line in the order note, status history, notification, invoice sent again |
| same | Confirmed / Processing | **not changed** – 🔔 request in the order note + HIGH notification; the bot says the team will confirm |
| same | Shipped | request + notification + handed to a person |
| cancel | **Pending** | status **Cancelled**, ❌ line in the order note, notification, lead → lost |
| cancel | Confirmed / Processing | **not cancelled** – 🔔 request in the order note + HIGH notification |
| cancel | Shipped | request + notification + handed to a person |

- **Messenger / Instagram:** the bot is told the channel and asks for a phone number before confirming
  (orders need one there). Order status messages and invoices are now sent on the customer's own channel
  (`BotAdminService.sendCustomerMessage`); before, they always went to WhatsApp.
- **Invoice PDF:** after the bot saves or changes an order (setting `auto_send_invoice`, default on),
  using the existing invoice feature (`sendInvoiceForCompany`). Instagram cannot receive PDF files – the
  invoice link is sent as text.
- **Notifications:** `bot_notification` rows are added to the existing Notifications feed
  (new orders, special notes, order changes, change / cancellation requests). The feed is cached for 60 s.
- **Products + services:** Sales bot → Settings → "What do you sell?" (auto / products / services / both).
  `GET /bot/sales-bot/sells` tells the dashboard which pages to show; a service business with
  products/both can use the product APIs.
- **Lead Management:** the bot moves chats forward only (new → contacted → qualified → proposal → won;
  lost when a pending order is cancelled) and fills `bot_conversation.lead_details`
  (need, budget, location, contact time, booking, order value, lost reason) shown on the cards.
- Migration: `migrations/supabase_sales_bot_orders.sql` (runs at startup).

### If "Confirmed" still does not work in your live database
The code saves every status (tested). Check the column in Supabase:
```sql
select data_type, udt_name from information_schema.columns where table_name='bot_order' and column_name='status';
select pg_get_constraintdef(oid) from pg_constraint where conrelid='bot_order'::regclass and contype='c';
```
If it is an enum or a CHECK without `Confirmed`, that is the cause (not changed here).

## Update: bot stays on, Client notes, invoice PDF, products + services

- **The bot no longer switches itself off.** When a person is needed (customer asks, order needs a check,
  bot error), the bot keeps replying and the team gets a **Client note** (🙋 reason) + a HIGH notification,
  and the chat is routed to an agent. Sales bot → Settings → "Switch the bot off when a person is needed"
  brings back the old behaviour. The bot still stops when an agent accepts the chat (status active).
- **Order details missing** → the bot asks for them (name / address / phone) instead of stopping.
  "Yes" before a summary → the backend sends the real summary (prices from `product`) and asks again.
- **Notes:** only notes about a specific order go to the order note; everything else goes to Client notes.
- **Invoice PDF** is now a real file: WhatsApp → document (same sending as the inbox "send file"),
  Messenger → file attachment, Instagram → link (Instagram cannot receive files). If a file cannot be sent,
  the link is sent instead. The PDF is stored with the chat media and served by this API at a signed link
  valid 90 days – **set `PUBLIC_API_BASE_URL`** (e.g. `https://api.yourdomain.com/v1/api`). Without it the
  old location (`BOT_INVOICE_DIR` + `BOT_PUBLIC_BASE_URL`, the old Python bot) is used.
- **Customer asks for the invoice** ("bill eka evanna") → the bot sends it (`send_invoice`), no handoff.
- **Products and services:** Settings → Business Type now has **Products & services** (`business_category = both`).
  The Sales bot follows it (one place to set it).

### Fixed while doing this (existing code)
- `ChatMediaPublicController` was never registered in `BotAdminModule`, so every public media link
  (invoice PDFs, Instagram media from the inbox) returned 404. It is registered now.

## Setup

1. Deploy the Python sales bot (separate service, `sales-bot-python`), with `BOT_API_KEY` and `GEMINI_API_KEY`.
   `DATABASE_URL` is **not** needed – this backend sends the data with each request.
2. In this backend's `.env`:
   ```
   SALES_BOT_URL=http://<python-bot-host>:8000
   SALES_BOT_API_KEY=<same as BOT_API_KEY in the Python bot>
   SALES_BOT_TEST_MODE=false        # true only to use the dashboard's Customer simulator
   ```
3. Restart. The migrations `migrations/supabase_sales_bot.sql` and `supabase_sales_bot_products.sql` run automatically at startup
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
| `product.selling_points`, `related_product_ids`, `show_to_bot` | product data for the bot (`supabase_sales_bot_products.sql`) |
| `bot_delivery_zone.included_kg`, `per_extra_kg` | optional weight rule per zone |
| `bot_order.total_weight_kg` | order weight used for the delivery fee |

Bot messages are saved in `bot_message` with `source = 'sales_bot'` and `intent`
(`order`, `booking`, `lead`, `handoff`, or several, e.g. `lead,handoff`).

## Endpoints (all admin-only, JWT)

`/bot/services`, `/bot/delivery-zones`, `/bot/bookings`, `/bot/sales-bot/settings`,
`/bot/sales-bot/test`, `/bot/sales-bot/simulate` (+ `/status`, `/conversation`),
`/bot/sales-bot/replies`, `/bot/sales-bot/reports` – contract in the frontend's `docs/SALES_BOT_API.md`.
The unassigned queue (`/bot/conversations/unassigned`) now also returns `queue_reason`
`bot_handoff | order_check | bot_error` and `queue_note`.

## Files

New: `src/sales-bot/*` (incl. `delivery-fee.ts`), `src/common/sales-bot-hook.ts`,
`migrations/supabase_sales_bot.sql`, `migrations/supabase_sales_bot_products.sql`.
Products (for the bot fields): `products/entities/*.ts`, `products/dto/create-product*.dto.ts`,
`products/products.service.ts` (create/update/CSV import of the new fields).
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
10. **Variant prices from `variant_price_match` are copied into each variant when products are saved**
    (`applyVariantDefaults` puts the base price on variants without a price). The bot uses the saved
    variant price first, so a later change to the price-match table only applies after the product is saved again.
11. Status messages / invoices for Messenger & Instagram customers used to go to WhatsApp (fixed in this update, see above).
