# Agent Metra – going live checklist

Services: **API** (NestJS, port 3001), **web app** (static files from `frontend/dist`) and the
**AI sales bot** (your separate Python service at `SALES_BOT_URL`). Everything uses the Supabase database.

## 1. Do these first (security)

1. **Change every secret that was in the old `.env` files.** The uploaded projects contained real values
   (database password, `JWT_SECRET`, Evolution API key, Meta app secret, Pinecone / Gemini keys, Messenger /
   Instagram tokens). Treat them as leaked:
   - Supabase → reset the database password, update `PRODUCT_DATABASE_URL`.
   - Evolution → create a new API key.
   - Meta app → reset the app secret; regenerate Page / Instagram tokens.
   - Google AI Studio (Gemini) and Pinecone → create new keys, delete the old ones.
2. Never put `.env` files in git or in a zip again (`.gitignore` already blocks them).
3. Set a new `JWT_SECRET` (64+ random characters). All users sign in again once – that is expected.
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

## 2. API `.env` – required values

| Setting | Value |
| --- | --- |
| `PRODUCT_DATABASE_URL` | Supabase pooler URL (new password) |
| `JWT_SECRET` | 64+ random characters |
| `CORS_ORIGINS` | `https://app.agentmetra.lk` (every web address that opens the app, comma separated) |
| `APP_PUBLIC_URL` / `PUBLIC_API_BASE_URL` | public web app address / public API address ending in `/v1/api` |
| `TRUST_PROXY` | `1` behind Nginx, `2` behind Cloudflare + Nginx |
| `META_APP_SECRET` | Meta app secret (webhook signatures are refused without it) |
| `EVOLUTION_WEBHOOK_TOKEN` | random value; then press **Save** once on each Evolution WhatsApp account so the webhook URL is refreshed |
| `N8N_INTERNAL_API_KEY` | random value, same in n8n |
| `SALES_BOT_URL` / `SALES_BOT_API_KEY` | address of the AI sales bot / same key as in the sales bot `.env` |
| `CHAT_MEDIA_SECRET` | random value |
| `PUSHER_*` | Pusher app keys (real-time inbox; without them the inbox polls) |
| `SUPER_ADMIN_EMAILS` | Metrocoding staff emails |
| `OTP_DEV_MODE` | `false` in production (only `true` on a test database) |
| `SMTP_*`, `OTP_WHATSAPP_*` | so sign-up and forgot-password codes are delivered |

Database changes are applied automatically when the API starts.

## 3. Web app

```bash
cd frontend && npm ci
echo "VITE_API_BASE_URL=https://api.agentmetra.lk/v1/api" > .env.production.local   # + VITE_PUSHER_KEY, VITE_GOOGLE_CLIENT_ID
npm run build      # upload dist/
```

Nginx example:

```nginx
server {
  server_name app.agentmetra.lk;
  root /var/www/agent-metra/dist;
  gzip on; gzip_types text/css application/javascript application/json image/svg+xml;
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
  location / { try_files $uri /index.html; add_header Cache-Control "no-cache"; }
}
server {
  server_name api.agentmetra.lk;
  client_max_body_size 25m;
  location / { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }
}
```

## 4. AI sales bot (`agent-metra-sales-bot`, FastAPI)

Reply logic unchanged. In its `.env`:

| Setting | Value |
| --- | --- |
| `GEMINI_API_KEY` | **new** Google AI key (the old one was committed in the bot's git history) |
| `BOT_API_KEY` | **new** long random value – the same value as `SALES_BOT_API_KEY` in the API `.env` |
| `BOT_MODEL`, `THINKING_LEVEL` | as before (e.g. `gemini-3.8-flash`, `low`) |
| `EXPLICIT_CACHE=true` | keep on – about 70–80 % cheaper input per message |
| `DATABASE_URL` | leave empty – the API sends all business data with each message |

Run one uvicorn process: `uvicorn app.main:app --host 127.0.0.1 --port 8000`, keep the port private, and set
`SALES_BOT_URL=http://127.0.0.1:8000` in the API `.env`. The old MySQL knowledge bot is not needed any more.

## 5. After deploy – 5 minute smoke test

1. Open the web app → sign in as company admin → Dashboard loads.
2. Top bar → switch Light / Dark mode.
3. Team → Agents → add an agent → sign in as the agent in another browser → only agent menu items show.
4. Send a WhatsApp message to the business number → it appears in Inbox / Chat queue.
5. Sign in as super admin → `/admin` → Companies list loads.
6. `curl -i https://api.agentmetra.lk/v1/api/company` → `401` (not data).

Full step-by-step checks are in **Agent_Metra_Manual_Test_Guide.xlsx**.
