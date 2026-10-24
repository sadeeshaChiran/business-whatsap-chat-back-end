# Data update 2026-10-24 – clean database, industry demos, trained bots

One command builds one SQL file; one command applies it. Everything is safe to run again.

```bash
# 1. build (checks every training file first)
bash scripts/make-final-data.sh > final-data-update.sql

# 2. BACK UP first, then apply
pg_dump "$DATABASE_URL" > backup-before-2026-10-24.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f final-data-update.sql
```

## What it does

| Step | File | Result |
| --- | --- | --- |
| 00 | `data/00-sync-sequences.sql` | Moves id sequences forward to MAX(id) (needed only after restoring an Adminer dump; harmless otherwise) |
| 01 | `data/01-cleanup-keep-vora-chulk.sql` | Deletes every company except **VORA**, **Chu.lk** and **Agent Metra**, with all their logins, products, chats, orders and settings. Inside VORA and Chu.lk deletes the simulator / scale-test customers (numbers starting with `999`) and their chats, orders, notes and AI usage. Real customer chats stay. Hides the unused `scale` test package. Stops without changing anything if VORA or Chu.lk is missing. |
| 01b | `data/02-fresh-start-vora-chulk.sql` | **Go-live fresh start, runs only once.** Deletes ALL customers, chats, messages, orders, bookings, notifications, notes, leads, comments and AI usage of VORA and Chu.lk. Keeps logins, products, photos, zones, services, bot settings, AI knowledge / training, channels, package. Saves the marker `fresh_start_vora_chulk` in `platform_setting`, so running the update again later never touches real chats. |
| 01c | `data/03-credits-and-packages.sql` | **1 credit = 100,000 tokens ≈ 1 customer chat.** Packages in chats a month: Free 30, Starter 250 (Rs 4,990 launch / 6,500), Growth 550 (8,990 / 12,000), Business 1,000 (14,990 / 20,000), Pro 1,600 (23,990 / 32,000). Top-ups: 100 chats Rs 1,500, 300 Rs 3,900, 1,000 Rs 12,900. Cost check: `docs/ai-cost-calculator.html`. |
| 02 | `make-industry-demos.py` | Creates / updates the **Agent Metra** company (`agentmetra@gmail.com`) and 7 industry demo companies with products |
| 03 | `bot-training/make-training.mjs` × 10 | Bot settings, delivery zones, services, policies, style examples and FAQs for Chu.lk, VORA, Agent Metra and the 7 demos |

## Logins (password `12345678`, change with `DEMO_PASSWORD=... bash scripts/make-final-data.sh`)

| Company | Industry | Sells | Owner login | Agent login |
| --- | --- | --- | --- | --- |
| Agent Metra | Our own sales bot | services (packages, top-ups, demo calls) | `agentmetra@gmail.com` | – |
| Nova Gadgets | Online shops | products | `novagadgets@demo.test` | `novagadgets.agent@demo.test` |
| Bright Path Campus | Education | services | `brightpath@demo.test` | `brightpath.agent@demo.test` |
| Glow & Go Beauty Studio | Beauty and health | both | `glowandgo@demo.test` | `glowandgo.agent@demo.test` |
| Spice Route Kitchen | Food | both | `spiceroute@demo.test` | `spiceroute.agent@demo.test` |
| Island Trails Travel | Travel and tourism | services | `islandtrails@demo.test` | `islandtrails.agent@demo.test` |
| Golden Vows Weddings & Events | Weddings and events | services | `goldenvows@demo.test` | `goldenvows.agent@demo.test` |
| Apex Solar Energy | High-value sales | both | `apexsolar@demo.test` | `apexsolar.agent@demo.test` |

VORA (`vora@gmail.com`) and Chu.lk keep their existing passwords.

## After applying

1. Log in as `agentmetra@gmail.com` → **Channels** → connect the Agent Metra sales WhatsApp number, then set the same number in
   **Super admin → Branding → WhatsApp** so the website's "Demo on WhatsApp" buttons open it.
2. Open **AI sales bot → Test chat** in each account and try the questions in the website's industry pages.
3. Optional marked test (needs `SALES_BOT_TEST_MODE=true` on the API while testing):
   ```bash
   API_URL=http://localhost:6001/v1/api CLIENT_EMAIL=agentmetra@gmail.com CLIENT_PASSWORD=12345678 \
     node scripts/client-test.mjs scripts/bot-training/clients/agentmetra.json
   ```

## Changing the training

Edit the texts in `scripts/bot-training/build-client-files.py` (or the JSON files in `clients/`), then:

```bash
python3 scripts/bot-training/build-client-files.py scripts/bot-training/clients
node scripts/bot-training/make-training.mjs scripts/bot-training/clients/vora.json > vora.sql && psql "$DATABASE_URL" -f vora.sql
```

Package prices in the Agent Metra bot (`clients/agentmetra.json` → services) are copied from the packages table on 2026-10-24
(launch offers until 31 Dec 2026). Update them there when prices change in Super admin → Packages.

## Website live demo

`/demo` on the website lets visitors chat with the 7 demo companies' real AI (API: `GET /v1/api/public/demo/businesses`,
`POST /v1/api/public/demo/reply`). Nothing is saved; AI usage is logged on the demo company as a test row (visible in Super admin).
Limits: `PUBLIC_DEMO_PER_MINUTE` per visitor (12), `PUBLIC_DEMO_DAILY_LIMIT` for the whole site (3,000 replies ≈ Rs 2,400 worst case),
24 messages per demo chat. `PUBLIC_DEMO=off` switches it off (the site then shows recorded chats).
