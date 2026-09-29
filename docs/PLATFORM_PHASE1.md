# Agent Metra platform – Phase 1: super admin, packages, AI tokens

## Levels
| Level | Who | Sees |
|---|---|---|
| Super admin | Metrocoding team (`app_user.is_super_admin`) | Agent Metra admin: companies, packages, token usage **and real AI cost**, token adjustments |
| Company admin | customer | AI **tokens only** (never cost), package, reset date |
| Agent | customer's staff | unchanged |

Make someone super admin: add their login email to `SUPER_ADMIN_EMAILS` (comma separated) and restart,
or `UPDATE app_user SET is_super_admin = TRUE WHERE email = '...';`.

## Packages (`platform_package`)
Seeded: Free (Rs 0, 50k tokens, 3 agents), Growth (Rs 3,500 / Rs 35,000, 500k tokens, 10 agents),
Scale (Rs 7,500 / Rs 75,000, 2M tokens, unlimited agents) – change them in Agent Metra admin → Packages.
`companies.plan` keeps the package **code**, so existing code paths keep working.
Replaced the hard-coded rules: "AI bot only on Free" → any active package; "max 3 agents" → package `max_agents`.
Companies can still only pick Free themselves – paid packages are set by the super admin (Phase 2: after payment).

## Tokens
- Tokens = input + output tokens of every sales-bot reply (`bot_ai_usage`, test chat included).
- **Reset every month** from the subscription start (also on yearly packages) – `company_subscription.token_period_*`.
- Available = package tokens + extra tokens. Extra tokens (`token_adjustment`): temporary ones count until
  they expire; others count until the end of that token month. Negative = remove.
- 80% → notification. 100% → notification, **the bot stops** (chats stay with agents), the test chat is blocked.
  Also stops when the package is expired (`period_end` passed) or suspended.
- Companies never receive cost: the test chat and Bot reports return tokens only.

## Endpoints
- Super admin (JWT + `SuperAdminGuard`): `GET /super-admin/overview`, `GET /super-admin/companies?search=`,
  `GET /super-admin/companies/:id`, `PATCH /super-admin/companies/:id/subscription`,
  `POST /super-admin/companies/:id/token-adjustments`, `GET|POST /super-admin/packages`,
  `PATCH /super-admin/packages/:id`, `GET /super-admin/usage?days=`.
- Company: `GET /billing/usage` (tokens, no cost).
- Public (no login, for the pricing page in Phase 5): `GET /public/packages`.

## Database (startup migration `supabase_platform_packages.sql`)
`app_user.is_super_admin`, `platform_package`, `company_subscription`, `token_adjustment`.
Subscriptions are created automatically on first use from `companies.plan`.

## Tests
The sales-bot / meta / bot-admin tests pass (16). These test files were **already failing before this update**
and were not changed: `products.service.spec.ts`, `whatsapp-channel-settings.util.spec.ts`,
`company.controller.spec.ts`, `company.service.spec.ts` (14 tests).

## Next phases
2 Billing (PayHere + bank slip approval, bank details, invoices, auto-renew) · 3 Channels (WhatsApp / Instagram check,
new connect screens) · 4 Agent Metra brand + UI refresh + guides · 5 public website.
The Settings page "Workspace package" still shows the old Free/Growth/Scale cards until Phase 2 replaces it with real checkout.
