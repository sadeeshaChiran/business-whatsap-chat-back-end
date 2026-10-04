# Agent Metra – API (NestJS)

The main backend of Agent Metra: login and roles, companies (workspaces), team, WhatsApp / Messenger / Instagram
inboxes, AI sales bot, products, orders, CRM, marketing, automation flows, billing and the super-admin platform.

Stack: NestJS 11 · TypeORM · PostgreSQL (Supabase) · Pusher (real-time) · Meta Graph / Evolution API.

## Quick start

```bash
npm ci
cp .env.example .env          # fill in at least PRODUCT_DATABASE_URL and JWT_SECRET
npm run build
npm run start:prod            # http://localhost:3001/v1/api
```

Database changes run automatically on start-up (`src/database/run-startup-migrations.ts` runs the files in
`migrations/` in order; every file is safe to run again). No manual SQL is needed for a new or existing database.

## Roles

| Role | Who | Can do |
| --- | --- | --- |
| `super_admin` | Metrocoding staff (`SUPER_ADMIN_EMAILS`) | Platform: all companies, packages, payments, suspend / activate a company, branding (logo, name, colour, contact details) |
| `admin` | Company owner (`companies.admin_user_id`) | Everything inside their own company: settings, channels, team, products, billing, AI, marketing |
| `agent` | Employee added by the admin | Their chats, the queue, orders, customers, own profile and password |

Rules are enforced on the server (`@AdminOnly()` / `@Roles()` on controllers, company id always taken from the
login token, never from the request). `npm run routes` prints every route with its protection.

## Security built in

- Login tokens signed with `JWT_SECRET` (required, no default). "Sign out everywhere", password change, disabling an
  agent or suspending a company invalidate existing logins at once (`token_version`).
- Login lockout after 8 wrong passwords (15 min), generic error messages, rate limits on login / sign-up / codes.
- Passwords: minimum 8 characters with letters and numbers; forgot / reset password by email or WhatsApp code.
- Helmet security headers, strict CORS (`CORS_ORIGINS`), body size limit, compression.
- Webhooks: Meta signature (`META_APP_SECRET`) checked, Evolution webhooks need `EVOLUTION_WEBHOOK_TOKEN`,
  n8n calls need `N8N_INTERNAL_API_KEY`; real-time channels are private (`POST /realtime/auth`).
- Secrets (tokens, API keys) are never returned to agents; CSV exports are protected against formula injection.
- One error format for every failure: `{ success: false, statusCode, message, errors?, data: null }` with a
  user-friendly message; internal details are logged, never sent.

## AI sales bot

The AI replies come from the separate Python sales bot (`SALES_BOT_URL`, see `docs/SALES_BOT.md`). The API gives it
everything from Supabase on each message (products, prices, delivery zones, AI knowledge). AI knowledge and uploaded
documents (PDF / Word / text, read on the server – no AI cost) are saved straight to Supabase; there is no separate
sync step and no MySQL. The old "knowledge bot" (Flask + MySQL) is no longer used.

## Tests

Use a **test** database (the tests create workspaces). Start the API with `OTP_DEV_MODE=true` first.

```bash
npm test                      # unit tests (jest)
npm run test:security         # 60 security tests: roles, tenant isolation, tokens, webhooks, rate limits…
npm run test:perf             # speed + load test → test/performance-result.json
```

Environment for the API tests: `API_URL=http://localhost:3001/v1/api` and `TEST_DATABASE_URL=postgresql://…`.

## Folder map

```
src/auth            login, Google login, password change / reset, guards, roles
src/verification    sign-up with email / WhatsApp code
src/company         company profile + industries (read-only list)
src/users           team (agents), work status
src/bot-admin       inbox, conversations, customers, orders, agent routing
src/integrations    WhatsApp (Meta + Evolution), Messenger / Instagram, webhooks
src/sales-bot       AI sales bot settings + orders
src/products        products, categories, import
src/crm  src/marketing  src/social  src/automation
src/billing  src/platform   packages, payments (PayHere / bank slip), super admin, branding
src/notifications   bell notifications     src/realtime   Pusher channel auth
migrations/         SQL run on start-up
test/               security + performance suites
docs/               feature notes and sample import file
```

See `docs/DEPLOYMENT.md` for the going-live checklist.
