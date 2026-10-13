# 3. Using the super admin console

The console is at **/admin** (same login as the app). Only emails in `SUPER_ADMIN_EMAILS` and admins added in **Team & system** can open it. A new super admin needs up to ~15 seconds (account cache) before the console opens for them. Every change you make here is written to the **Audit log**.

## Dashboard

- Revenue this month, MRR, paying companies, total companies and active in the last 7 days, AI cost this month (USD).
- **Need attention**: bank slips waiting, blocked companies, companies above 80% of their credits. Check this every morning.
- Revenue chart (12 months), renewals due in the next 14 days, companies per package. CSV export of companies and payments.

## Companies

Search a company by name, email or phone and open it.

| Action | What it does | When to use |
| --- | --- | --- |
| Change package / cycle / status / period end | Edits the subscription directly | Fixing a wrong payment, giving extra days |
| Restart credit month | Starts a fresh credit month now | After a mistake that used credits (e.g. a bot loop) |
| Add credits | Permanent or temporary (default 14 days) credits with a reason | Goodwill, compensation, testing |
| Free trial (section) | Give or end a trial for this company | Sales follow-up, a customer asking to try Growth |
| Custom package (section) | Private package for this company only | Special deals (more agents, different price) |
| Suspend workspace | Signs everyone out immediately and stops the bot | Non-payment after warnings, abuse |
| Re-activate | Lifts the suspension | After payment / resolution |
| Record manual payment | Marks a payment received outside the app | Cash or direct bank deposit without a slip |

Select several companies with the checkboxes to give a **bulk trial**. There is no "log in as company" feature: ask the customer for screenshots, or reproduce with a test company.

## Payments

1. Filter **Awaiting approval**.
2. Open the slip (the link works for 1 hour).
3. Check the amount and the bank account against the slip. If correct → **Approve**. The package starts (or extends) immediately and an invoice PDF is created.
4. If wrong → **Reject** with a clear reason ("Amount is Rs 3,000, the package is Rs 3,500"). The customer gets a HIGH notification and can upload a new slip.

## Packages

- Basics: name, code (lowercase, **cannot change later** – companies store it), description, sort order.
- Prices: monthly and yearly (Rs). Offer price per month/year, last day of the offer and a label ("Launch offer").
- Quotas: AI credits per month (the editor shows ≈ replies), max agents / products / services (empty = unlimited), **AI bot free days** (`bot_days`, empty = always; Free uses 30).
- Limit switches: Messenger, Instagram, Social, **Credits unlock channels** (`credits_unlock`), Lead management, CRM, Ads & leads, Meta ads pro, Campaigns, Broadcasts, Mobile app; numbers: broadcasts per month, report history days.
- Pricing-page text: extra feature lines.
- Changes reach companies within 30 seconds (cache). Changing a package changes it for **every** company on it – for one company use a custom package instead.

## Free trials

- **Sign-up trial**: on/off, which package, how many days. Off by default. When on, every new company gets it automatically.
- **Give a trial**: choose companies (one or bulk), package (Free and custom packages are not offered), days (1–366), note. Companies that are paying are skipped and listed.
- **Trial report**: active, ended, converted to paid.
- When a trial ends the company returns to Free (or the fallback package). Their data stays.

## Announcements

Title, message, priority (LOW / MEDIUM / HIGH) and company ids (empty = everyone). They show in each company's Notifications. Use HIGH only for outages or action-required notices.

## Usage & AI cost

Tokens and AI cost per company over N days: replies, tokens, cost, cost per reply, average speed. Use it to spot a company with very expensive replies (huge catalog or knowledge) or a bot loop.

## Billing & credits

- **Credit rate**: "1 credit = 1 AI reply = N tokens" (minimum 1,000). Changing it changes how fast every company uses credits – announce it first.
- Bank details and the note shown to customers paying by transfer.
- **Credit packs (top-ups)**: name, credits (tokens), price, valid days, active.

## Branding

Platform name, tagline, logo, legal company name, support email / phone / WhatsApp, website, address and the brand colour. Used by the website, the user guide (`/docs`), sign-in, every company's app, emails and invoices.

## Audit log

Who changed what and when, for every super-admin change. Secret-looking fields (password, token, secret, PIN) are masked. Use it when a customer asks "who changed my package?"

## Team & system

- Add or remove super admins (the email must already have an account).
- **System health**: Python sales bot status, replies in the last 24 h, average and p95 reply time, cache hit rate, bot errors.
- **Config checks**: public API URL, dashboard URL, PayHere, Meta app, SMTP, WhatsApp verification number, Pusher. A red item here explains many "it doesn't work" tickets.

## Team handbook

This handbook (`/admin/docs`). The **Client guide** tab shows the same user guide customers see at `/docs`. Use **Print / Save as PDF** to keep an offline copy.
