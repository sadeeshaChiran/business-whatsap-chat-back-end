# Agent Metra – update A to E

## A. Credits
Companies see **AI credits** only (1 credit = 50,000 tokens, changeable in the admin console → Billing & credits).
One bot reply ≈ 0.1 credit. Packages / top-ups are still stored in tokens; everything shown to companies is converted.
Optional: `migrations/optional_agent_metra_packages.sql` sets Free 30 / Small 120 / Medium 480 / Busy 1,440 credits and 3 top-ups
(run it once in Supabase – it is NOT run automatically).

## B. Super admin console
Super admins (SUPER_ADMIN_EMAILS or `app_user.is_super_admin`) see **only** the platform console at `/admin`:
Dashboard (revenue per month, MRR, renewals in 14 days, slips waiting, CSV export), Companies (+ Company 360 and
"record a payment"), Payments, Packages, Announcements, Usage & AI cost, Billing & credits, Audit log, Team & system.
Every POST/PUT/PATCH/DELETE by a super admin is written to `platform_audit_log` (secrets masked).
Migration: `supabase_platform_admin.sql`.

## C. Verified sign-up
`POST /auth/register/start` → 6-digit codes to the email **and** the WhatsApp number → `POST /auth/register/verify`
creates the account (same creation as before) and logs in. `POST /auth/register/resend`.
Codes: hashed (HMAC), 10 minutes, 5 wrong tries, 60 s between sends, 6 per hour. The password waits encrypted
(AES-GCM) for max 30 minutes. The old `POST /auth/register` is blocked (`REGISTRATION_VERIFICATION=false` re-opens it).
The business email = the admin's login email (cannot be edited in company settings).
`/auth/change-email/start|verify` (password + code to the NEW email) and `/auth/change-whatsapp/start|verify`.
Google sign-in is unchanged (Google already verified the email; the WhatsApp number can be added in Settings).

**WhatsApp codes need:** a Meta **authentication** template on your WhatsApp Cloud number (Meta's standard
"verification code" template with a copy-code button), then `OTP_WHATSAPP_PHONE_NUMBER_ID` / `OTP_WHATSAPP_TOKEN` /
`OTP_WHATSAPP_TEMPLATE`. Without it, set Notify.lk for SMS. Migration: `supabase_verification.sql`.

## D. Settings + setup wizard
Settings: quick links, Account & security (email + WhatsApp with verification), one email field.
New sign-ups open `/setup` (business → package → channel → catalog → bot → done); it can be reopened from Settings / Guide.

## E. CRM (`/crm`, admins and agents)
Contacts = chat customers (all channels) with search / stage / channel / tag filters and sorting; contact 360 drawer
(stage, deal value, phone, email, tags, notes, follow-up tasks, timeline, open chat); Tasks & follow-ups (mine / everyone,
reminder notification when due within 1 hour); CSV import (name, phone, email, tags) and export.
API: `/crm/contacts`, `/crm/contacts/:id`, `/crm/contacts/:id/notes`, `/crm/tasks`, `/crm/team`, `/crm/contacts/import|export`.
Migration: `supabase_crm.sql`.

## F. Mobile app support
`/mobile/inbox` (admins: all chats, agents: their chats; filters all / mine / waiting / bot, search, unread counts),
`/mobile/conversations/:id/messages` (50 at a time, `before_id` for older, media paths), `/mobile/conversations/:id/read`,
`/mobile/devices` (register / remove the phone for push).
Push notifications (Firebase Cloud Messaging HTTP v1): new customer messages → the assigned agent (else the admin);
alerts from Notifications (MEDIUM / HIGH) → the admin. Set `FCM_SERVICE_ACCOUNT_JSON`. Checked every 10 seconds; old
history is never pushed. Migration: `supabase_mobile.sql`. The Flutter app is in `agent-metra-app.zip`.
