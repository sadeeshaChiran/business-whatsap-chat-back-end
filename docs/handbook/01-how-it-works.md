# 1. How the platform works

This handbook is for the Agent Metra team: the owner, support staff and developers. It explains how every part of the platform works, how to help customers when something goes wrong, and how to run and deploy the system. It is only visible to super admins (Platform admin console → **Team handbook**).

> **Note:** This handbook never contains passwords, tokens or keys. Environment variables are listed by **name** only. Real values live only in the server `.env` files and in the password manager.

## The big picture

Agent Metra is a multi-company (multi-tenant) SaaS. Every business that signs up is a **company**. Each company has one **owner (company admin)** and optional **agents**. Customers of those businesses write on WhatsApp, Messenger or Instagram, and the platform answers with an AI sales bot, routes chats to agents, and takes orders and bookings.

| Part | Technology | Where it runs | What it does |
| --- | --- | --- | --- |
| Web app + public website | React, Vite, Tailwind | Static files (`dist/`) behind Apache | The dashboard for companies, the public site (`/`, `/pricing`, `/docs`, legal pages) and the super admin console (`/admin`). |
| API | NestJS (Node), TypeORM + raw SQL | pm2 process, port **3001**, prefix `/v1/api` | All business logic, webhooks from Meta, billing, timers, file storage for chat media. |
| Database | PostgreSQL on Supabase | Supabase (pooler connection) | All data. Schema changes run automatically when the API starts. |
| AI sales bot | Python FastAPI + Google Gemini | uvicorn, private port (default 8000) | Writes the bot replies, comment replies and post captions. |
| Realtime | Pusher | Pusher cloud | Pushes new messages to open browsers. Without Pusher the inbox polls every 8 seconds. |
| WhatsApp (official) | Meta WhatsApp Cloud API | Meta | Sending and receiving WhatsApp messages, templates, broadcasts. |
| WhatsApp (QR) | Evolution API | Separate Evolution server | Optional "QR code" WhatsApp. Set up by the platform team only – there is no self-service screen. |
| Messenger / Instagram / Social | Meta Graph API | Meta | Messages, comments, posts, insights, ads. |
| Payments | PayHere (card) + bank transfer slips | PayHere | Package and top-up payments. |

## How a customer message flows

1. The customer sends a WhatsApp message. Meta calls our webhook `POST /v1/api/integrations/whatsapp/webhook/meta`.
2. The API checks the **signature** with `META_APP_SECRET` (and `META_APP_SECRETS_EXTRA` during an app change). A wrong secret means **every message is refused** – it looks like "the bot stopped".
3. The API finds the company by the phone number id, creates or updates the **customer** (`bot_channel_user`) and the **conversation**, and stores the message.
4. **Ad capture runs first** (`MarketingHook.run`). If the message came from a Click-to-WhatsApp ad or a shared post, the ad (title, text, image, link, ad id) is saved to the conversation and to `marketing_ad_click`. This happens *before* the bot so the bot already knows the ad.
5. **Automation flows** run next (`FlowHook`). If a flow or a form is waiting for this customer, it handles the message and the bot stays quiet.
6. **Agent routing** decides if the chat needs an agent (see "Team" in chapter 2).
7. **Sales bot**: the API waits a short time (debounce, default 4 s, max 15 s) so several quick messages are answered together. Then it checks credits (`canBotReply`), builds the context (shop data, catalog, chat history, campaign/ad info) and calls the Python bot `POST /reply` with the `X-Bot-Key` header.
8. The bot answers with text and **actions** (save order, change order, booking, handover, lead stage…). The API validates every action again (prices, delivery fee, time slots), saves it and sends the reply to WhatsApp.
9. Pusher tells the open dashboards; the agent sees the message instantly.

Messenger and Instagram work the same way through `POST /v1/api/integrations/meta/messages/webhook`.

## Background timers in the API

| Timer | Interval | What it does |
| --- | --- | --- |
| Billing sweep | every hour | Renewal reminders (7 days and 1 day before), ends trials, ends Free bot days, reminders 3 days before. |
| Flow tick | `FLOW_TICK_MS` (default 15 s) | Continues flows that were waiting ("Wait" steps). Up to 50 per tick. |
| Sales-bot follow-ups | `SALES_BOT_FOLLOWUP_TICK_MS` (default 60 s) | Sends due follow-up messages (09:00–20:30 Sri Lanka time only). |
| Agent routing | `AGENT_ROUTING_CHECK_MINUTES` (default 1 min) | Moves un-accepted chats to the next agent, assigns queued chats when agents come online. |
| Marketing | 15 s | Sends broadcasts in batches (25 recipients every 15 s), Conversions API events. |
| Social | 60 s / 2 min | Publishes scheduled posts, syncs comments. |
| CRM | 10 min | Task reminders (1 hour before due). |
| Mobile push | 10 s | Push notifications to the mobile app. |

> **Warning:** Run the API as **one** process (pm2 fork mode, not cluster). The timers above run inside the process; two copies would send broadcasts and follow-ups twice.

## Database and migrations

- All schema changes are SQL files in `backend/migrations/`. The list of files that run at start is `MIGRATION_FILES` in `src/common/run-startup-migrations.ts`.
- Every file is written to be safe to run again (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- A failing statement is logged as a warning and skipped (except one critical file, where it stops the start). Always read the pm2 log after a deploy.
- Do not use a `;` inside a `--` comment in a migration – the SQL splitter would cut the statement there.
- Files in `migrations/manual/` and `optional_*.sql` are **not** run automatically. Run them by hand in the Supabase SQL editor only when a release note says so.

## The AI sales bot (Python)

- Endpoints: `GET /health`, `POST /reply`, `POST /social/comment-reply`, `POST /social/caption`. All POST calls need `X-Bot-Key` = `BOT_API_KEY` (the API sends `SALES_BOT_API_KEY`; they must match).
- Model: `BOT_MODEL` (Gemini Flash family), thinking level `THINKING_LEVEL` (default low).
- **Prompt cache:** shop data (catalog, policies, style examples) is cached at Gemini per business (`EXPLICIT_CACHE=true`, `CACHE_TTL_SECONDS` default 3600). The cache is rebuilt automatically when shop data changes. This makes replies faster and cheaper – keep it on.
- **Quality guards** (`SKIP_THANKS`, `FREE_GREETING`, `CONFIRM_GUARD`, `SKIP_OK`, `STUCK_HANDOFF`): skip pointless replies ("ok", "thanks"), avoid wasting credits, and hand over when the bot loops.
- Optional vector search (`VECTOR_SEARCH`) for big catalogs.
- The bot **never decides prices or delivery fees** – the API recalculates everything from the database before saving.

## Multi-tenant safety

- Every query is scoped by `company_id`. Agents only see chats assigned to them; admin-only actions return "Only the company admin can do this."
- Messenger/Instagram senders are looked up per Page (`pageCompany()`), so two companies with the same customer never mix.
- Super admin access: emails in `SUPER_ADMIN_EMAILS` plus the admins added in **Team & system**. Every super-admin change is written to the **Audit log** (secret-looking fields are masked).
- Bank slips and chat media are served with signed URLs that expire.

## Code map

| Folder (backend `src/`) | Contents |
| --- | --- |
| `auth`, `users`, `verification` | Login, Google login, registration with code (email / WhatsApp / SMS), password reset, sign out everywhere. |
| `company` | Company profile, business type, industry. |
| `integrations/whatsapp`, `integrations/meta`, `integrations/evolution` | Webhooks, sending, connection check and "Fix it". |
| `bot-admin` | Inbox API: conversations, messages, notes, tags, orders from chat, chat origin (ads). |
| `sales-bot` | Engine that calls the Python bot, follow-ups, delivery fee, booking slots, handover. |
| `agent-routing` | Assigning chats to agents, queue, timeouts. |
| `crm` | Contacts, pipeline, tasks, import/export. |
| `flows` | Automation flows and forms, public form page. |
| `marketing` | Templates, broadcasts, campaigns, links & QR, ad capture, Ads & leads, Meta ads, audiences, Conversions API. |
| `social` | Comments, AI replies, posts, calendar, insights. |
| `platform` | Packages, limits, credits, trials, billing, super admin, branding, this handbook. |
| `notifications`, `realtime`, `mobile` | In-app notifications, Pusher auth, mobile app API and push. |
| `products` | Products, variants, images. |

Frontend: `src/components/screens/*` (one folder per area), `src/app/navigation.ts` (the menu), `src/pages/public/*` (website, legal pages, `/docs`), `src/components/screens/superAdmin/*` (console). The client user guide is in `frontend/src/docs/client/*.md`.
