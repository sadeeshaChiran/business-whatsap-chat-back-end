# Agent Metra – Phases 2–5

## Phase 2 – Billing
- Packages monthly / yearly and **token top-up packs**, paid by **PayHere** (card, optional **auto-renew**
  via the Recurring API) or **bank transfer** (slip upload → super admin approves / rejects).
- A paid payment activates the package (a renewal of the same package extends the end date) or adds the
  top-up tokens (valid `valid_days`), creates an **invoice PDF** (`AM-YYYY-000123`) and notifies the company.
- Renewal reminders 7 days and 1 day before the end date (packages without auto-renew), checked hourly.
- PayHere notify URL: `POST {PUBLIC_API_BASE_URL}/public/payhere/notify` – verified with `md5sig`
  and the amount / currency. Forged or changed notifications are ignored. Each auto-renew charge becomes a new payment.
- Super admin: Payments (queue of slips, view slip, approve / reject with a reason, invoices), Billing settings
  (your **bank details**, token packs, PayHere status).
- Migration: `migrations/supabase_platform_billing.sql` (startup).

### .env
```
PAYHERE_MERCHANT_ID=...
PAYHERE_MERCHANT_SECRET=...
PAYHERE_SANDBOX=true            # false for live
PAYHERE_APP_ID= / PAYHERE_APP_SECRET=   # optional: cancel auto-renew from the app
PUBLIC_API_BASE_URL=https://api.yourdomain/v1/api
APP_PUBLIC_URL=https://app.yourdomain
```
In the PayHere portal: add your domain, and for auto-renew ask PayHere to enable the **Recurring API**.
Sandbox test: pay a package with a PayHere test card, then check Billing → Payments.

## Phase 3 – Channels
- **WhatsApp: fixed** – after Embedded Signup the number is now **registered** for the Cloud API
  (`/{phone_number_id}/register`, PIN from `WHATSAPP_REGISTRATION_PIN` or random). Before, new numbers could not
  send / receive ("Account not registered"). Already registered numbers are fine.
- Embedded Signup uses `sessionInfoVersion 3` and accepts all `FINISH…` events (coexistence numbers).
- **Instagram / Messenger:** `business_management` added to the default scopes (Pages owned by a Business portfolio
  were missing from the list). If you set `META_OAUTH_SCOPES` yourself, add it there too, and make sure the Meta
  app has these permissions approved.
- New `GET /integrations/meta/health` – live checklist on each channel screen (token works, webhook subscribed,
  number quality, Instagram linked, and the two settings that must be switched on in Meta / Instagram).
- Must be done in Meta (cannot be done by code): app Webhooks → **Instagram → messages**, and in the Instagram
  app **Allow access to messages**.

## Phase 4 – Brand, UI, guides
- Brand **Agent Metra – by Metrocoding** (logo, favicon, title, login, sidebar, invoices).
- New screens: Billing, Guide (setup checklist with live progress + how-to guides), super admin tabs,
  channel help + health checklist, token usage card / banner. Inter font and global polish.

## Phase 5 – Public website (same app)
Logged-out visitors see Home, Pricing (live from your packages), Guides, Contact, Log in, Sign up.
Edit the contact details in `frontend/src/pages/public/PublicSite.tsx` → `SITE_CONTACT`.
