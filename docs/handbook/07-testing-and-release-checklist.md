# 7. Testing and release checklist

Every change is tested before it reaches customers. Tests run against a **test database** (never production) and a fake Meta server, so no real messages are sent.

## Test setup

- A local Postgres test database (`TEST_DATABASE_URL`, e.g. `agentmetra` on localhost) – the API runs against it with `OTP_DEV_MODE=true` and `SALES_BOT_TEST_MODE=true`.
- Fake Meta: tests start a small server and the API runs with `META_GRAPH_BASE_URL=http://127.0.0.1:4599` and a test `META_APP_SECRET`.
- Test accounts and companies are created by the tests themselves with random names.

## Backend (API)

| Command | What it checks |
| --- | --- |
| `npm test` | Unit tests (jest, `src/**/*.spec.ts`): delivery fee, booking slots, referral capture, WhatsApp error texts, document reading, guards … |
| `npm run test:security` | Security and business rules against a running API: tenant isolation, agent vs admin rights, super admin only, packages and offers, quoted replies, feedback, follow-ups, free delivery, service limits, simulator, trials and the team handbook access |
| `npm run test:team` | SMS sign-up codes, supervisor rights, agents change only their own orders + activity log, automatic accept, pipeline stage by hand, product photos as files (upload, public link, fake image refused), own SKU / optional weight, import sample file; plus the agent-work flow (needs the fake bot) |
| `npm run test:flows` | Automation flows and forms |
| `npm run test:crm` | CRM, marketing, social, customer insights (visits, groups, tags, per-click ad results) |
| `npm run test:meta` | Meta connection check, flows from comments/ads, **Ads & leads** report, ad capture, Messenger ad-card replies, Instagram story replies |
| `npm run test:marketing` | Campaigns |
| `npm run test:trials` | Free trials, Free bot month, credits unlock, custom packages |
| `npm run test:perf` | Speed of the main API routes (compare with `test/performance-result.json`) |
| `node test/salesbot-contract.mjs` | The API and the Python bot still understand each other |

## Web app

| Command | What it checks |
| --- | --- |
| `npm run build` | TypeScript check + production build |
| `npm run lint` | Code style and React hook rules |
| `npx playwright test` | End-to-end: every page as admin (light and dark), agents, inbox, ads in chat, Ads & leads, broadcasts explained, automation, CRM, bookings, follow-ups, onboarding and trials, super admin, legal pages, **docs**, phone layout, speed |
| `npm run docs:pdf` | Rebuilds the public user guide PDF (`public/downloads/agent-metra-user-guide.pdf`) from `/docs` – needs the web app running (`npm run dev` or preview) |

> **Tip:** Running the whole Playwright suite quickly can hit the login rate limit (10 per minute per IP). If tests fail with 429, wait a minute and re-run only the failed files.

## AI sales bot

Each test file is a script: `python tests/test_quality_guards.py`, `test_booking_time.py`, `test_campaign_notes.py`, `test_cost_savings.py`, `test_delivery_rounding.py`. Conversation samples in `tests/*.txt` are used for manual checks with `chat_cli.py`; quality evals are in `evals/`.

## Release checklist

Copy this list into the release note and tick it:

1. All backend suites pass (jest, security, flows, crm, meta, marketing).
2. Web app builds, lint is clean, Playwright passes.
3. Bot tests pass (if the bot changed) and the contract test passes.
4. New env names are added to `.env.example` (names and safe defaults only) and to chapter 6.
5. New migrations are listed in `MIGRATION_FILES` and are safe to run twice.
6. The **user guide** (`frontend/src/docs/client/`) and this **handbook** (`backend/docs/handbook/`) are updated for any feature change; the PDF is rebuilt.
7. The zips/archives contain **no `.env`** – only `.env.example`.
8. Deploy (chapter 6), smoke test, and write the release note in the project docs.

## Updating the documentation

- **User guide** (public, `/docs`): Markdown files in `frontend/src/docs/client/NN-slug.md`. The first `# ` line is the chapter title; `##` lines become the sections in the sidebar and search. Write `{{brand}}` where the platform name should appear – it is replaced with the name from Branding. Then `npm run docs:pdf` and commit the new PDF.
- **Team handbook** (this, super admins only): Markdown files in `backend/docs/handbook/NN-slug.md`, served by `GET /v1/api/super-admin/handbook`. Changes show after an API deploy (cached for 1 minute).
- Supported formatting: headings, paragraphs, **bold**, *italic*, `code`, links, bullet and numbered lists, tables, code blocks and notes (`> **Tip:**`, `> **Note:**`, `> **Warning:**`).
- Never put passwords, tokens, keys or customer data in either guide.
