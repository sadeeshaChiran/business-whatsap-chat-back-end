# 6. Operations and deploy

How the production server is set up, how to release a new version safely, and how to look after keys, backups and logs.

> **Warning:** Never commit `.env` files, never put them in a zip, and never paste their values in chat, tickets or this handbook. Each project ships only an `.env.example` with names and safe defaults.

## Production layout

| Service | How it runs | Address |
| --- | --- | --- |
| Web app + website | Static files from `frontend/dist`, served by Apache (SPA fallback to `index.html`) | Main domain |
| API | `node dist/main` under **pm2** (one process, fork mode) on `127.0.0.1:3001`, reverse proxy by Apache | API domain → `/v1/api` |
| AI sales bot | `uvicorn app.main:app --host 127.0.0.1 --port 8000` (one process) under pm2 or systemd | Private only (`SALES_BOT_URL=http://127.0.0.1:8000`) |
| Database | Supabase Postgres (pooler URL) | Supabase |

### Apache notes

- Proxy the API domain to `http://127.0.0.1:3001/` and pass `X-Forwarded-For` / `X-Forwarded-Proto`. Set `TRUST_PROXY=1` (or `2` behind Cloudflare + Apache).
- **`ProxyTimeout 120` (or more)** – Facebook + Instagram posting with video and big uploads take longer than the default and are cut off otherwise.
- Allow request bodies up to 25 MB (`BODY_SIZE_LIMIT_MB`, chat media up to 16 MB).
- Web app: long cache for `/assets/*`, `no-cache` for `index.html`, and fall back to `index.html` for every unknown path (so `/docs`, `/admin`, `/f/…` work on refresh).
- Static files win over the SPA fallback – the user guide PDF at `/downloads/agent-metra-user-guide.pdf` is served directly.

(An equivalent Nginx config is in `backend/docs/DEPLOYMENT.md`.)

## Environment variables (names only)

### API (`backend/.env`)

| Group | Names |
| --- | --- |
| Server | `NODE_ENV`, `PORT`, `TRUST_PROXY`, `RATE_LIMIT_PER_MINUTE`, `BODY_SIZE_LIMIT_MB`, `CORS_ORIGINS` |
| Database | `PRODUCT_DATABASE_URL`, `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`, `DB_POOL_MAX` |
| Login | `JWT_SECRET`, `JWT_SECRET_LEGACY` (only during rotation), `JWT_TTL_SECONDS`, `META_OAUTH_STATE_SECRET`, `GOOGLE_CLIENT_ID` |
| URLs and media | `PUBLIC_API_BASE_URL`, `APP_PUBLIC_URL`, `SHORT_LINK_BASE_URL`, `CHAT_MEDIA_DIR`, `CHAT_MEDIA_SECRET` |
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_APP_SECRETS_EXTRA`, `META_OAUTH_REDIRECT_URI`, `META_OAUTH_SUCCESS_REDIRECT`, `META_GRAPH_API_VERSION`, `META_OAUTH_CONFIG_ID`, `META_WHATSAPP_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_MESSAGING_VERIFY_TOKEN`, `META_OAUTH_SCOPES`, `WHATSAPP_WEBHOOK_REQUIRE_SIGNATURE`, `WHATSAPP_REGISTRATION_PIN` |
| Evolution (QR) | `EVOLUTION_API_BASE`, `EVOLUTION_API_KEY`, `EVOLUTION_WEBHOOK_URL`, `EVOLUTION_WEBHOOK_TOKEN`, `EVOLUTION_WEBHOOK_EVENTS`, `EVOLUTION_WEBHOOK_BY_EVENTS`, `EVOLUTION_WEBHOOK_BASE64`, `EVOLUTION_READ_MESSAGES`, `EVOLUTION_ALWAYS_ONLINE`, `EVOLUTION_GROUPS_IGNORE` |
| n8n (legacy) | `N8N_WHATSAPP_WEBHOOK_URL`, `N8N_FORWARD_META_INBOUND`, `N8N_INTERNAL_API_KEY` |
| Sales bot | `SALES_BOT_URL`, `SALES_BOT_API_KEY`, `SALES_BOT_TEST_MODE` (never in production), `SALES_BOT_DEBOUNCE_MS`, `SALES_BOT_DEBOUNCE_MAX_MS`, `SALES_BOT_PART_DELAY_MS`, `SALES_BOT_TIMEOUT_MS`, `SALES_BOT_FOLLOWUP_TICK_MS` |
| Routing | `AGENT_PENDING_TIMEOUT_HOURS`, `AGENT_ROUTING_CHECK_MINUTES` |
| Flows | `FLOW_TICK_MS`, `IG_MEDIA_WAIT_MS` |
| Debugging | `META_WEBHOOK_LOG` (1 = log raw Messenger / Instagram events – contains customer text, keep off) |
| Realtime | `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER`, `PUSHER_HOST`, `PUSHER_PORT` |
| Platform | `SUPER_ADMIN_EMAILS` |
| Payments | `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `PAYHERE_SANDBOX`, `PAYHERE_APP_ID`, `PAYHERE_APP_SECRET` |
| Codes (sign-up, reset) | `REGISTRATION_VERIFICATION`, `OTP_DEV_MODE` (false in production), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `NOTIFYLK_USER_ID`, `NOTIFYLK_API_KEY`, `NOTIFYLK_SENDER_ID`, `NOTIFYLK_BASE_URL` (optional) – sign-up / change-number codes by SMS. The old `OTP_WHATSAPP_*` settings are no longer used. |
| Mobile push | `FCM_SERVICE_ACCOUNT_JSON` (native app), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (browser / phone notifications – optional, created automatically if empty; never change once set), `PUSH_TICK_MS` |
| Tests only | `META_GRAPH_BASE_URL` (fake Meta server – never set in production) |

### Web app (`frontend/.env.production.local`, used at build time)

`VITE_API_BASE_URL` (ends in `/v1/api`), `VITE_PUSHER_KEY`, `VITE_PUSHER_CLUSTER`, `VITE_PUSHER_HOST`, `VITE_PUSHER_PORT`, `VITE_GOOGLE_CLIENT_ID`, `VITE_BOT_ORDER_CURRENCY_SYMBOL`, `VITE_THEME`.

> **Note:** `VITE_*` values end up inside the public JavaScript. Only put public values there (never a secret).

### AI sales bot (`salesbot/.env`)

`GEMINI_API_KEY`, `BOT_MODEL`, `THINKING_LEVEL`, `BOT_API_KEY` (= the API's `SALES_BOT_API_KEY`), `EXPLICIT_CACHE`, `CACHE_TTL_SECONDS`, `HISTORY_LIMIT`, `PRICE_INPUT`, `PRICE_CACHED`, `PRICE_OUTPUT`, `SKIP_THANKS`, `FREE_GREETING`, `CONFIRM_GUARD`, `SKIP_OK`, `STUCK_HANDOFF`, `VECTOR_SEARCH`, `EMBED_MODEL`, `VECTOR_MIN_PRODUCTS`, `PRESEARCH`, `VECTOR_DB_PATH`, `DATABASE_URL` (leave empty).

## Releasing a new version

Do these steps in order. Do them outside the busiest hours (evenings in Sri Lanka are busy for shops; early morning is best).

1. **Read the release notes** (project docs `agent-metra-*.md`) for new env values and manual steps.
2. **Back up**: make sure the Supabase daily backup ran today (Supabase → Database → Backups). For a big release take a manual backup first.

**3. API**

```bash
cd /path/to/agent-metra-api
# replace the code with the new version (keep the existing .env!)
npm ci
npm run build
pm2 restart <api-name> --update-env
pm2 logs <api-name> --lines 100     # watch the migrations run – look for "warning" lines
```

**4. AI sales bot** (only if it changed)

```bash
cd /path/to/agent-metra-sales-bot
pip install -r requirements.txt
pm2 restart <bot-name>              # or: systemctl restart <service>
curl -s http://127.0.0.1:8000/health
```

**5. Web app**

```bash
cd /path/to/agent-metra-web
npm ci
npm run build                       # uses .env.production.local
# upload / copy dist/ to the Apache document root
```

**6. Smoke test** (5 minutes):

- Website `/`, `/pricing`, `/docs` open; the PDF downloads.
- Sign in as a company admin → Dashboard, Inbox load. Light/Dark switch works.
- Send a WhatsApp message to a test business number → it appears in the Inbox and the bot replies.
- Super admin `/admin` → Companies load; Team & system → sales bot OK and config checks green.
- `curl -i {API}/v1/api/company` returns **401** (not data).

**7.** Write a short note in the project docs: date, version, anything unusual.

### Rolling back

- Code: put the previous build back and restart (`pm2 restart … --update-env`). Migrations are additive (new columns/tables), so the old code keeps working with the newer database.
- Data: restore from the Supabase backup only for real data loss – it rewinds every company.

## Keys and secrets

- **Where**: only in the server `.env` files and the team password manager.
- **Rotate** after anyone leaves the team, after a leak, and at least once a year:
  - `JWT_SECRET`: put the old value into `JWT_SECRET_LEGACY`, set a new one, restart. Remove the legacy value after `JWT_TTL_SECONDS` (default 7 days). Without the legacy step everybody is signed out once.
  - Meta app secret: reset in the Meta app, update `META_APP_SECRET`, restart immediately (webhooks are refused until both match).
  - `SALES_BOT_API_KEY` / `BOT_API_KEY`: change both together, restart both.
  - Database password: reset in Supabase, update `PRODUCT_DATABASE_URL`, restart.
  - Gemini, PayHere, Pusher, SMTP, Notify.lk, Evolution keys: create new in the provider, update, restart, delete the old one.
- **If a secret leaks** (shared in chat, committed, in a zip): rotate it now, then check the audit log and provider dashboards for misuse.

## Monitoring and logs

| What | Where |
| --- | --- |
| API errors, webhook refusals, migrations | `pm2 logs <api-name>` |
| Bot speed, errors, cache hit rate | Super admin → Team & system |
| AI cost per company | Super admin → Usage & AI cost |
| Channel health of a company | The company's Channels → connection check |
| Slips waiting, companies over 80% | Super admin → Dashboard → Need attention |
| Database size / load | Supabase dashboard |

## Backups

- Supabase takes daily backups automatically (check the retention for the plan in use).
- Chat media files are stored on the API server in `CHAT_MEDIA_DIR` – include this folder in the server backup. **Product photos** are in `CHAT_MEDIA_DIR/products` (links `…/public/product-images/…`) – losing it breaks product photos for customers and the bot.
- Migration `supabase_oct18_photo_match.sql`: `product.image_hashes` / `image_hashes_src`, `bot_message.media_note` / `media_match`. On the first start after deploy the API fingerprints all product photos in the background (no AI cost). The sales bot needs **Pillow** (`pip install -r requirements.txt`).
- Migration `supabase_oct17_updates.sql` (runs on start): `bot_conversation.bot_answered_inbound_id`, `bot_conversation.lead_stage_manual`, `product.image_notes` / `image_notes_src`, `companies.agent_auto_accept` (default true), `app_user.team_role`, table `company_activity_log`.
- Keep a copy of the three `.env` files in the password manager (not on a laptop, not in email).

## Rate limits (for reference)

| Endpoint | Limit per IP per minute |
| --- | --- |
| Everything (default) | `RATE_LIMIT_PER_MINUTE` (600) |
| Login, Google login | 10 |
| Register, change password, forgot password, register start/resend | 5 |
| Register verify, password reset | 10 |
| Public form submit / photo upload | 10 / 20 |

Webhooks, PayHere notify and public branding are not limited. 8 wrong passwords lock an account for 15 minutes.
