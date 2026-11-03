# 4. Support playbook

How to handle customer tickets. Each problem has **what the customer says**, **checks** (in order – most common first) and **the fix**. Always start with the three quick checks below.

## Before anything: three quick checks

1. **Which company and which channel?** Get the company name / login email and the channel (WhatsApp, Messenger, Instagram).
2. **Channels → connection check.** Ask the customer to open Channels → WhatsApp (or Messenger) and press **Check again**, then send a screenshot. Most channel problems are named there in plain words, with a **Fix it** button.
3. **Super admin → Companies → the company.** Look at package, status (suspended?), credits used, trial and `blocked_reason`.

> **Tip:** Super admin → Team & system → **Config checks** shows server-wide problems (Meta app, Pusher, SMTP, PayHere). If many customers complain at once, look there first.

## The bot is not replying

| Check | What you see | Fix |
| --- | --- | --- |
| Messages arrive at all? | Inbox shows no new messages | Go to "WhatsApp messages are not arriving" below. |
| AI reply switch for this chat | Header shows "Manual" / AI reply off | Turn **AI reply** on in the chat (an agent accepted the chat, or a handover switched it off). |
| Bot on for the business | AI sales bot → "Bot is off" | Turn on "Bot replies to customers". |
| Credits | Billing shows 100% used, `blocked_reason = tokens` | Customer buys a top-up or upgrades. You can add temporary credits as goodwill. |
| Free month over | `blocked_reason = free_ended` | Free package bot month ended. Customer buys credits or a package (or give a trial). |
| Package expired / suspended | `expired` / `suspended` | Payment needed; or re-activate. |
| Bot per customer | AI → Bot per customer → "Enable bot" | The customer was switched off individually. |
| Form or flow waiting | A form question is open in the chat | The bot stays quiet while a form runs. Customer types *stop*, or it times out. |
| Python bot down | Team & system → sales bot not OK | Restart the bot service (chapter 6). Check `GEMINI_API_KEY` quota. |
| Bot skipped "ok"/"thanks" | Last customer message was "ok" or "thanks" | This is by design (quality guards) – no reply needed. |

## WhatsApp messages are not arriving

1. **Connection check → "Meta is calling the webhook"**. If it says calls are *refused: invalid signature* → `META_APP_SECRET` on the server is wrong or the WABA is still subscribed to the **old** app. Fix the secret (or set the old secret in `META_APP_SECRETS_EXTRA` while moving), restart with `pm2 restart <api> --update-env`.
2. **"Messages are sent to Agent Metra (webhook)"** red → the WABA is not subscribed to our app → **Fix it** (subscribe WhatsApp).
3. **"Number is registered for the Cloud API"** red → **Fix it** → enter the 6-digit two-step verification PIN (set in WhatsApp Manager). Error 133010 means the same.
4. **Access token** red → token expired or lost permissions (error 190) → reconnect with "Connect with Meta", or create a new permanent System User token (chapter 5).
5. Meta app webhook (developers.facebook.com → WhatsApp → Configuration): URL `…/v1/api/integrations/whatsapp/webhook/meta`, field **messages** subscribed.
6. If none is red and still nothing: check the API log (`pm2 logs`) for the webhook call and errors.

## Messenger / Instagram problems

| Problem | Checks | Fix |
| --- | --- | --- |
| Messenger messages don't arrive | Page subscribed? Connection check | **Fix it** (subscribe Page) or reconnect the Page. |
| Only some people's messages arrive | Meta app in Development mode | Only people with a role on the app can message. Switch the app to Live after App Review. |
| Instagram messages don't arrive | Professional account? Linked to the Page? | Instagram app → Settings → Messages and story replies → Connected tools → **Allow access to messages** ON. Reconnect. |
| Bot can't send after 24 h | Customer's last message > 24 h ago | Meta's rule. Wait for the customer to write again. |
| Messenger/Instagram locked ("upgrade") | Package lacks `messenger` / `instagram` | Upgrade, or buy credits if the package has **credits unlock**. |
| Instagram photo arrives late | Media download wait | `IG_MEDIA_WAIT_MS` (default 40 s). Normal. |

## Messenger / Instagram ad chats not marked as ads

1. Channels → Messenger → **Check again**: "Ad clicks are sent to Agent Metra" (Page subscription has `messaging_referrals`) and "Meta app: Messenger webhook fields" must be green → **Fix it** otherwise. Same for Instagram (`messaging_referral`).
2. Ask the customer (or test yourself from an account with a role on the app) to click the ad and send a message. Then open **Technical details → What Meta sent lately**:
   - "ad / link click – referral: ADS, OPEN_THREAD, ad …" or a customer message with "referral: …" → Meta sends the ad; the chat should be marked. If not, escalate with the time.
   - "customer message – reply to an earlier message" only → the customer replied to the ad card. We read the card from Meta; if it still isn't marked, Meta refused to share the card (see the API log line "replied-to message … could not be read") – escalate.
   - Only "customer message" (no referral, no reply) → normal for ads with a welcome message. The API reads the Page conversation from Meta and brings in the card + greeting. If they don't appear, look for "recent messenger messages could not be read from Meta" in the API log (usually a Page token without `pages_messaging` / `pages_read_engagement` – reconnect the Page).
   - Neither → Meta is not sending ad information for this ad type. Check the ad's destination is Messenger / Instagram Direct (not a website).
3. For deep debugging only: set `META_WEBHOOK_LOG=1`, restart the API, reproduce, read `pm2 logs`, then remove it again (the log then contains customer messages).

## "Ads & leads shows Talking for a customer who bought before"

Correct since October: results count only what happened after that click. The **Bought before** badge marks returning buyers; the full history is in CRM → Customer insights.

## Broadcasts fail

The Broadcasts page shows the main problem on top with a fix. Common Meta codes:

| Code | Meaning | Fix |
| --- | --- | --- |
| 131058 | `hello_world` sample template – only works from Meta's test number | Create the company's own template in Marketing → Message templates. The sample is now blocked in the form. |
| 132001 | Template not in this language or deleted | Pick the template again. |
| 132000 | Wrong number of values ({{1}}, {{2}}) | Fill every value. |
| 132005 / 132007 | Text too long / breaks template rules | Shorter values. |
| 132015 / 132016 | Template paused/disabled by Meta (low quality) | Use or create another template. |
| 131026 | Number can't receive (not on WhatsApp, old app) | Check the number with the customer. |
| 131049 | Meta held it back (too many marketing messages to this person) | Try in a few days; send less often. |
| 131050 | Customer stopped marketing messages | Don't send marketing to this number. |
| 131047 | More than 24 h – only templates allowed | Send a template. |
| 131056 | Too many messages to the same number quickly | Wait and retry. |
| 130429 / 131048 | Sending too fast / too many failures | Smaller groups; only customers who know the business. |
| 131031 | WhatsApp account locked/restricted | WhatsApp Manager → Account quality. |
| 131042 | Payment problem on the WhatsApp account | Add a payment method in WhatsApp Manager → Billing. |
| 133010 | Number not registered | Channels → WhatsApp → **Fix it**. |
| 190 / 10 | Token expired / lost permission | Reconnect WhatsApp. |

Also: broadcasts need the **Cloud API** (not QR), only text templates (no photo/video header), and the monthly limit of the package (`LIMIT_REACHED`).

## Template rejected by Meta

- Marketing templates need a clear business purpose; avoid "test", only variables, or misleading text.
- Variables cannot be at the very start or end, and need example values.
- Ask the customer to edit and submit again; approval usually takes minutes, sometimes 24 h.

## Ads problems

| Problem | Checks | Fix |
| --- | --- | --- |
| "Meta ads shows nothing / wrong ads" | Marketing → Meta ads: the selected ad account | The connected ad account may be a personal one that doesn't run the Page's ads. The page shows **"Your ads may be in another account"** → **Show that account**. Or Marketing settings → reconnect and choose the business ad account. |
| Ad chats not marked as "from ad" | Was it a Click-to-WhatsApp / Messenger ad? | Only messages that carry Meta's referral are marked. Boosted posts with a "Send message" button do carry it; a customer who types the number by hand does not. |
| Ad shows no image | Meta sometimes sends no media | Normal – title and text still show. |
| Customer came from 2 ads | Inbox banner | The banner shows the **last** ad on top and lists the earlier ads; each message shows its own ad card. |
| Spend / ROAS empty | Ad account connected? `marketing_pro`? | Connect the ad account in Marketing settings; the package needs Meta ads pro. |

## Forms in chat

- "The form looks messy": since October every question is one clean message ("📝 Title – N quick questions…", "*1/N* Question?", hint). Old screenshots may show the old format.
- "Customer is stuck in a form": the customer types *stop* (or cancel / exit / nevathanna / epa). After 3 wrong answers the team takes over automatically.
- "Form link doesn't open": `APP_PUBLIC_URL` must be the public dashboard URL; the form must be active.

## Orders, bookings and delivery

| Problem | Explanation / fix |
| --- | --- |
| Wrong delivery fee | Check Delivery zones: the area name must match (or a `*` zone exists) and, for zones that charge by weight, product weights are set (weight is optional otherwise). Weight is rounded up by default (2.3 kg → 3 kg). |
| Bot sends a link instead of a photo / no photo | The product needs a photo in Media gallery. Uploaded photos are links like `…/public/product-images/12-x.jpg` – open it in a browser; 404 = file missing on the server (restore `CHAT_MEDIA_DIR/products` from backup). `PUBLIC_API_BASE_URL` must be the public API address, or Instagram/WhatsApp can't download the photo. |
| Bot doesn't recognise a customer's photo | Look at the note under the photo in the inbox (Our product / Not sure / Not in our shop). "Not sure" = two products look alike or the photo is unclear – the bot asked the customer (by design). Check the product has its own clear photos (each colour as an option photo) and `product.image_hashes` is filled (saving the product refreshes it; needs `SALES_BOT_URL`). |
| Bot picked the wrong product | Very rare: tell us the chat. Check both products don't share the same photo, and that option photos are set. Live check with real photos: `evals/photo_match.py` in the sales bot. |
| Product photo not delivered on WhatsApp | API log "sending product N photo failed": photo link not reachable, or the file is not a picture. WEBP/GIF are converted automatically (needs the sales bot running). |
| Import added duplicates | Rows match existing products by SKU, then by exact name. Give each product a SKU in the file. |
| Agent says "You can only change your own orders" | The order is not the agent's (not taken by them and the customer isn't theirs now). The owner or a supervisor can change it. |
| "Who deleted this order?" | Team → Activity log → Deleted orders (shows who, when and the full order). |
| Bot says "the team will confirm the fee" | No zone matched and no `*` zone. Add the area or `*`. |
| Bot won't take a booking at a time | Outside opening hours, or capacity full ("Bookings at the same time"). It offers the 3 nearest free times. |
| Customer can't cancel an order in chat | Only Pending orders can be changed by the bot; others create a request for the team. |
| No invoice PDF | "Send invoice PDF automatically" off in AI sales bot settings. |

## Team and agents

| Problem | Fix |
| --- | --- |
| Agent gets no chats | The agent must be **Online** (top bar switch) and not "Away" on the Team board. |
| Chat stuck with an absent agent | With automatic accept on (default) chats are active right away – use "Move chats of an offline agent after", or reassign in the contact panel / Chat queue. With it off, it moves after "Move an un-accepted chat after". |
| Agent wants the Accept button back | Owner: Settings → Chat routing → turn off **Accept new chats automatically**. |
| Supervisor can't open a page | Supervisors can't open products, bot settings, automation, marketing, channels, billing or company settings – by design. |
| Pipeline stage keeps changing | The bot moves stages forward by itself; only a **Won/Lost picked by hand** is never changed. Pick the stage in the chat's contact panel. |
| A customer message got no bot reply | Check the chat: messages that arrive while the bot is writing are answered right after. If the bot is off for the chat or a person took over, it does not reply. |
| "Add agent" disabled | All seats used – remove an agent or upgrade (or custom package). |
| Agent can't see a page | Agents only see their own chats and agent pages; owner-only pages say "Only the company admin can do this." |

## Phone notifications

| Problem | Fix |
| --- | --- |
| "Turn on" does nothing / blocked | Browser blocked notifications for the site: lock icon → Notifications → Allow, reload. |
| iPhone: no button / not working | Must be iOS 16.4+, added to the home screen and opened from there. |
| Test says it could not be sent | Device list shows "last send failed" – turn off and on again on that device. Check the API can reach the internet (push services are Google / Apple / Mozilla). |
| Owner gets too many | Settings → Phone notifications → **Only chats that need a person**. |
| Agent gets nothing | Agent must be assigned the chat (or have it waiting to accept) and have turned notifications on in their own Settings. |
| All devices stopped after a server move | VAPID keys changed – keep `VAPID_*` (or the `platform_setting` row) when moving servers. |

## Login and account

| Problem | Fix |
| --- | --- |
| "Too many requests" (429) | 10 login attempts per minute per IP. Wait one minute. |
| Account locked | 8 wrong passwords → locked 15 minutes. Wait, or reset the password. |
| No verification code | Email: check SMTP in Config checks, ask the customer to check spam. SMS: Config checks → **SMS codes (Notify.lk)** must be green; check the Notify.lk balance and sender ID; the number must be a Sri Lankan mobile (07X…). WhatsApp is not used for codes any more. |
| Suspended workspace | Everyone is signed out. Re-activate in Companies after the issue is solved. |
| Lost phone / shared password | Settings → Password & sessions → **Sign out on all devices**, then change the password. |

## Billing and trials

| Problem | Fix |
| --- | --- |
| Paid by bank but package not active | Payments → Awaiting approval → check the slip → Approve. |
| Slip rejected, customer confused | They see the reason in a notification and can upload again in Billing. |
| Card payment not possible | PayHere not configured (Config checks). Use bank transfer. |
| Wants to stop auto-renew | Billing → switch off "Renew automatically". |
| Trial not given to a company | Paying companies are skipped. Check the trial report. |
| Trial ended, "features disappeared" | Back to Free – data is safe. Offer a package or extend the trial. |
| Messenger opened after buying credits, then closed | Credits expired or used up; `credits_unlock` only works while bought credits are valid. |

## Escalation

- **Developer needed** when: API or bot errors in logs, data looks wrong across companies, a Meta webhook is refused for everyone, payments callback fails.
- Write in the ticket: company id, channel, time of the problem (Sri Lanka time), customer phone (last 4 digits), screenshots, and what you already checked from this playbook.
- **Never** ask a customer for their Facebook password. Never paste tokens or passwords in chat or tickets.
