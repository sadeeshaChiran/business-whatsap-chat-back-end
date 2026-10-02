# Package limits & availability

## Package limits (super admin → Packages → Edit → "Features & limits")
Switches: Messenger, Instagram, Lead Management, CRM, Marketing – ad results, Marketing – Meta ads, WhatsApp broadcasts,
Mobile app. Numbers: max products, max agents, broadcast messages per month, report history (days). Empty = unlimited.
Starting values (migration `supabase_package_limits.sql`, only for packages without limits):
Free – WhatsApp bot, 20 products, 7-day reports, mobile app; Small – + Messenger, Instagram, Lead Management, CRM, ad results,
200 products; Growth (Medium) – + Meta ads, broadcasts 2,000 / month, 1,000 products; Scale (Busy) – everything, 10,000 broadcasts.
A key a package does not have = allowed (new features never break old packages). Changes apply at once.

Enforced in the backend (403 `FEATURE_LOCKED` / `LIMIT_REACHED` with "available from the X package"): `/crm/*`, marketing routes
(per feature), lead-stage changes, connecting a Facebook Page, `/mobile/*`, product create + CSV import (only new products count),
broadcast size per calendar month, report days. Messenger / Instagram off → the AI does not reply there (messages are still saved).
Nothing is deleted on downgrade. `GET /billing/usage` → `limits` (switches, numbers, upgrade hints); `GET /super-admin/limit-catalog`.
Website: 🔒 in the menu, "upgrade to unlock" pages, locked marketing tabs, ✓ / ✗ lists on Billing and Pricing.

## Availability instead of stock
Products, each variant option and services are **Available / Unavailable** (default available; migration `supabase_availability.sql`
adds `product.is_available`, `bot_service.is_available`; variant JSON gets `"available": false` only when off). Stock numbers stay in
the database but are not used. One tap: `PATCH /products/:id/availability {available, variant_value?}`; services via `PATCH /bot/services/:id`.
CSV: `available` and `variant_available` (yes / no). The bot sees "NOT AVAILABLE NOW" (never stock counts); the backend refuses to order an
unavailable item and replies "Sorry, X is not available right now – would you like something else?" in the customer's language
(no hand-over). Same for order changes.

Also fixed: a startup script switched the AI bot off at every restart for companies on paid packages (see supabase_packages_bot_off.sql);
the migration runner now understands `DO $$ … $$` blocks.
