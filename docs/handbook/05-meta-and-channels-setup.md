# 5. Meta app and channel setup

The platform uses **one Meta app** for all companies (WhatsApp Cloud API, Messenger, Instagram, Pages, Ads). If this app is misconfigured, every company is affected. Keep this chapter in sync with the real app.

## Meta app – settings

1. **Basic settings**: app domains (main site and API domain); Privacy policy URL `/privacy`; Terms URL `/terms`; Data deletion URL `/data-deletion`; category, icon, contact email.
2. **Facebook Login for Business → Settings**: Client OAuth login **Yes**, Web OAuth login **Yes**, Login with JavaScript SDK **Yes**, JS SDK allowed domain = the dashboard URL. Valid redirect URIs:
   - `{API}/v1/api/integrations/meta/callback`
   - `{API}/v1/api/public/marketing/meta/callback`
3. **Permissions** (Use cases → Customize → Add) – 18 in total:
   - Pages: `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `pages_manage_posts`, `read_insights`
   - Business: `business_management`
   - Instagram: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`, `instagram_manage_insights`
   - Ads: `ads_read`, `ads_management`
   - WhatsApp: `whatsapp_business_management`, `whatsapp_business_messaging`
4. **App Review**: each permission needs a screencast showing how it is used in Agent Metra. Until approved the app is in **Development mode** – Messenger/Instagram messages arrive only from people with a role on the app.

## Webhooks

| Product | Object | Callback URL | Verify token (env name) | Fields |
| --- | --- | --- | --- | --- |
| WhatsApp | WhatsApp Business Account | `{API}/v1/api/integrations/whatsapp/webhook/meta` | `META_WEBHOOK_VERIFY_TOKEN` | `messages` (+ `account_update`, `message_template_status_update`) |
| Messenger | Page | `{API}/v1/api/integrations/meta/messages/webhook` | `META_MESSAGING_VERIFY_TOKEN` | `messages`, `messaging_postbacks`, `messaging_referrals` (ad clicks), `message_echoes`, `message_deliveries`, `message_reads`, `feed` |
| Instagram | Instagram | same as Messenger | `META_MESSAGING_VERIFY_TOKEN` | `messages`, `messaging_postbacks`, `messaging_referral` (ad clicks), `messaging_seen`, `comments` |

> **Warning:** Without `messaging_referrals` (Page) / `messaging_referral` (Instagram) – in the app **and** on each Page subscription – Click-to-Messenger / Instagram ads look like normal chats. The connection check shows both, and **Fix it** adds them.

`{API}` is the public API address (for example `https://api.agentmetra.lk`). Every webhook call is signed by Meta; the API checks it with `META_APP_SECRET`.

## Server values that must match the app

| Env name | What it must be |
| --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | From the app's Basic settings |
| `META_APP_SECRETS_EXTRA` | The **old** app secret, only while moving companies from an old app |
| `META_OAUTH_REDIRECT_URI` | `{API}/v1/api/integrations/meta/callback` |
| `META_OAUTH_CONFIG_ID` | Empty (otherwise Instagram is forced on every shop) |
| `META_WHATSAPP_CONFIG_ID` | Embedded Signup configuration id (after becoming a Tech Provider); empty = manual setup only |
| `META_GRAPH_API_VERSION` | The Graph API version in use (e.g. `v25.0`) |
| `PUBLIC_API_BASE_URL` / `APP_PUBLIC_URL` | Public API URL ending in `/v1/api` / public dashboard URL |

After changing any of them: `pm2 restart <api-name> --update-env`.

## WhatsApp – manual setup for a company (when "Connect with Meta" can't be used)

1. In the company's Business portfolio: **System users** → add a System User (Admin).
2. Assign our app and the company's WhatsApp account (WABA) to that user with full control.
3. Generate a **never-expiring** token with `whatsapp_business_messaging`, `whatsapp_business_management` (and `business_management`).
4. In Agent Metra: Channels → WhatsApp → **Use manual setup** → number, WABA id, Phone number id, token, verify token → Save. Saving subscribes our app to the WABA automatically.
5. Register the number for the Cloud API if needed (**Fix it** → 6-digit PIN).
6. Run the connection check – all green – and send "hi" from another phone.

## Moving companies to a new Meta app

1. Put the old secret in `META_APP_SECRETS_EXTRA` so both apps' webhooks are accepted.
2. For each company: reconnect (or **Fix it → subscribe WhatsApp / subscribe Page**) so the WABA/Page is subscribed to the **new** app.
3. When the connection check shows every company on the new app, remove `META_APP_SECRETS_EXTRA` and restart.

## Evolution (QR WhatsApp)

- Optional, for numbers that can't use the Cloud API. Needs our Evolution server (`EVOLUTION_API_BASE`, `EVOLUTION_API_KEY`) and `EVOLUTION_WEBHOOK_TOKEN`.
- Set up by the platform team through the API (`integrations/evolution/instance`, `instance/qr`, `instance/status`). The phone must stay online.
- Not supported: broadcasts, templates, Meta ads attribution (ad cards still show when WhatsApp passes the ad preview).
