# 2. Every feature – how it works

This chapter goes feature by feature: what the customer sees, the rules behind it, and where it lives in the code. Use it to answer "why did it do that?" questions. The client-facing explanation of the same features is in the public **User guide** (`/docs`).

## Sign-up and first login

- Registration: name, company, email, **mobile number**, password. Two 6-digit codes are sent: one by email (SMTP) and one **by SMS via Notify.lk** (`src/verification/senders.ts` → `sendSmsCode`). WhatsApp is **not** needed for sign-up any more (the WhatsApp OTP sender was removed). Codes are valid 10 minutes. `REGISTRATION_VERIFICATION` controls this; `OTP_DEV_MODE` must never be true in production. API fields: `phone` / `phone_code` (the old `whatsapp` / `whatsapp_code` names still work). Changing the number later: `POST /auth/change-phone/start` + `/verify`.
- New companies start on **Free** right away (no "choose a package" wall). `SignupHook` calls `startNewCompany`: sets Free, gives **30 free AI-bot days** (`bot_free_until`) and applies the **sign-up trial** if it is switched on in Super admin → Free trials.
- After the first login the owner lands on the **Setup wizard** (`/setup`). It remembers the step it was on. Steps: **Business** (name, type: products / services / both) → **Plan** (shows Free or the trial – nothing to pay) → **Channel** (connect WhatsApp, Messenger or Instagram) → **Catalog** (products, services, delivery fees) → **AI bot** (about the business, hours, payments) → **Ready** (summary). The step is remembered per company in the browser. A floating "Back to setup" pill appears while the owner is away connecting a channel. The dashboard shows a **Getting started** card with the same live progress (`lib/setupProgress.ts`).
- Login protection: 10 login attempts per minute per IP; **8 wrong passwords lock the account for 15 minutes**.

## Packages, limits and credits

- Packages live in `platform_package`. Each has prices, monthly AI credits, max agents/products/services, `bot_days`, offer prices and **limit switches** (`package-limits.ts`): `messenger`, `instagram`, `social`, `credits_unlock`, `lead_management`, `crm`, `marketing_ads`, `marketing_pro`, `campaigns`, `broadcasts`, `mobile_app`, and numbers `broadcasts_per_month`, `reports_days`. A missing switch counts as **on**.
- Screens behind a switch show an upgrade card (`FeatureGate`); API routes check `RequiresFeature`. Package data is cached for 30 seconds – a change in the editor can take up to 30 s to show.
- **Credits**: 1 credit ≈ 1 average AI reply. The exact rate is "1 credit = N tokens" in Super admin → Billing & credits (default 9,000 tokens). Tokens are counted per reply in `bot_ai_usage`.
- The credit month resets monthly (also on yearly plans). At **80%** the company gets a warning notification; at **100%** the bot stops ("AI credits used up – the bot has stopped"). Inbox, agents, WhatsApp, orders keep working.
- `blocked_reason` in `/billing/usage`: `suspended`, `expired`, `tokens` (credits used up) or `free_ended` (Free package bot month is over).
- **Free package**: the bot works for `bot_days` (30) from sign-up. After that only **bought or given credits** let the bot reply. Everything else on Free keeps working.
- **Top-ups (credit packs)**: bought in Billing; valid for the pack's `valid_days`. If the package has `credits_unlock`, active bought credits also **switch on Messenger, Instagram and Social (comment replies)** while they last.

## Free trials and custom packages

- A trial gives a paid package for 1–366 days. Given by a super admin to one company or many (bulk), or automatically to new sign-ups (sign-up trial, off by default).
- A trial is refused for a company that is currently paying.
- When it ends (hourly sweep) or is stopped, the company goes back to its fallback package (normally **Free**). A reminder is sent 3 days before.
- If the company pays during the trial, the trial is marked **converted**.
- **Custom package**: a private package for one company (name, base package to copy limits from, price, credits, max agents/products, months). It only shows for that company and is not on the pricing page.

## Channels

- **WhatsApp Cloud API** (recommended): "Connect with Meta" (embedded signup) or manual setup (number, WABA id, phone number id, permanent token, verify token). Saving subscribes our app to the WABA automatically.
- **Connection check** (`GET integrations/meta/health`): token works and is permanent, number quality, number registered for Cloud API, WABA subscribed to *our* app, "Meta is calling the webhook" (last call accepted or refused + reason). **Fix it** buttons: register number (asks for the 6-digit two-step PIN), subscribe WhatsApp, subscribe Page.
- **Messenger**: "Connect Facebook Page" → choose the Page → messages are subscribed automatically.
- **Instagram**: Professional account linked to the Page; "Allow access to messages" must be on in the Instagram app.
- **QR WhatsApp (Evolution)**: backend only (`integrations/evolution`), webhook protected by `EVOLUTION_WEBHOOK_TOKEN`. Broadcasts and templates need the Cloud API.

## Inbox

- `/inbox` (admin, "Unified inbox") and `/my-chats` (agent). Up to 80 chats in the list, refresh every 8 s (or instantly with Pusher). A chat opens with the newest 40 messages.
- Filters: channel (All / WhatsApp / Messenger / Instagram); chips All, Unread, Assigned (admin) / To accept (agent), **From ads**, Starred (this browser only), Follow-up; tag chips.
- Each row shows channel, last message with ticks, origin chip (📣 Ad / shared post), follow-up pill (Interested / Ready to buy), agent name, Bot/Manual pill, unread count, up to 3 tags.
- **AI reply** switch in the header = manual mode for that customer (`bot_channel_user.manual`).
- **Ads in chat** (new): every message that came from an ad shows an **ad card** above it (image, "From your ad", title, text, link) – like WhatsApp. The banner on top shows the **last** ad the customer came from and "came from N different ads" with the earlier ads listed. Data: `GET bot-admin/conversations/:id/origin` returns every click (`marketing_ad_click`) of that customer, newest first, each linked to the message it started (`message_id`).
- Notes (internal, yellow), quoted replies (real replies on WhatsApp; on Messenger/IG the quote shows only in our inbox), 👍/👎 on bot replies (👎 can teach a better reply), tags, contact info panel, follow-up control.
- Media: documents, photos/videos, camera, audio, voice notes (converted to mp3/wav), location/contact/stickers (WhatsApp). Upload limit 16 MB; photos are resized to fit WhatsApp's 5 MB.
- Messenger/Instagram: the 24-hour rule is shown as a warning. Messenger/IG "templates" are card messages (title, text, image, buttons).
- **Create order / Add booking** from chat: only catalog items; prices and delivery fee are calculated by the server.

## Team and routing

- Seats come from the package (`max_agents`). Removed agents don't use a seat; their open chats go back to the queue.
- Agents switch **Online/Offline** in the top bar. Only online agents get new chats.
- Routing (`agent-routing.service.ts`): keep the current agent → else the customer's last ("sticky") agent if online → else the **least-busy online agent** (fewest pending + active chats with activity in 24 h; ties round-robin) → else the **Chat queue**.
- **Automatic accept** (`companies.agent_auto_accept`, default **true**, Settings → Chat routing): `assignConversationToAgent` sets the chat straight to **active** (`accepted_at` = now, sticky agent recorded, bot orders/bookings of the last 3 days attributed to the agent). When off, a new assignment is **pending** until the agent presses **Accept** (bar above the message box). Not accepted in time ("Move an un-accepted chat after", default 1440 min) → next agent. **Pass on** / **Hand back** sends it to another online agent or the queue. Accepting sends nothing to the customer and the bot keeps helping.
- **Roles**: owner (`companies.admin_user_id`), **supervisor** (`app_user.team_role = 'supervisor'`) and agent. JWT role is computed per request (`auth.service.ts → roleOf`). Supervisor = team lead: every chat, the queue, all orders, CRM, reports, Agent performance, Activity log, sees agents and sets their work status. Not allowed: products, services, delivery zones, bot settings/knowledge, automation, marketing, social, channels, billing, company settings, adding/removing agents. Backend: `@ManagerOnly()` (= `Roles('admin','supervisor')`), `assertManagerAccess` / `managesAll` in `bot-admin.service.ts`, `managerCompany` in `sales-bot-admin.service.ts`.
- **Orders by agents**: agents may change status, edit, send the invoice and delete **their own** orders (taken by them, or of a customer they hold now) – `findOrderForActor`. Others → 403 "You can only change your own orders."
- **Activity log** (`company_activity_log`, `src/activity-log/activity-log.ts`, `GET /activity-log`, owner + supervisors, page Team → Activity log): order status / edit (field old → new) / note / delete (full snapshot: customer, phone, address, items, total), manual pipeline stage changes and team-role changes. Writing never blocks the action.
- **Pipeline stage by hand**: owner, supervisor or the agent who has the chat (`PATCH /bot/conversations/:id/lead-stage`, needs the `lead_management` feature) and the CRM set `bot_conversation.lead_stage_manual = true`. The bot (`advanceLead`) and flows never change a hand-set **Won** / **Lost**.
- Team board (drag agents between Online / Offline / Away, drag chats between agents) and Agent performance (accept time, reply time, chats → sale, orders, value…). Orders made by the bot count for the agent who holds the customer.

- **Dashboard quick links** (`pages/dashboard/QuickLinks.tsx`): role-aware buttons to Inbox / My chats, Queue, Orders, Pipeline, AI bot details, Bot reports, Products, Agent performance, Agents, Activity log, Ads & leads, Settings. Status chips and card headers link to their pages.
- **Messages that arrive while the bot writes** are answered next: `bot_conversation.bot_answered_inbound_id` stores the last customer message a reply covered (a reply by a person also counts). After sending, the engine checks for newer customer messages and schedules another turn.

## AI sales bot

- Settings (`/ai/sales-bot`): on/off, bot name, reply language (same as customer / Sinhala / Singlish / Tamil / English), invoice PDF after orders (default on), switch the bot off when a person is needed (default off), follow-ups, tone, greeting, about the business, opening hours, payment methods. Test chat shows language, AI calls, speed, credits and decisions per reply – nothing is sent or saved.
- The bot only sells what is in the catalog with "Show to the sales bot" on. It never invents prices; the API recalculates.
- **Orders**: shows a summary with real prices + delivery fee, saves only after the customer agrees. Messenger/IG: always asks for a phone number first. Pending orders can be changed/cancelled by the bot; Confirmed/Processing → request to the team; Shipped → handover.
- **Bookings**: date/time checked against working hours (from Opening hours, default 08:00–20:00), duration (default 60 min) and capacity ("Bookings at the same time", default 1). If taken, it offers up to 3 nearest free times (30-min steps).
- **Handover** when: customer asks for a person or a call; complaints, refunds, damaged/late orders, payment problems or bank slips; price negotiation or bulk prices; no answer found; customer angry or confused; same question 3 times or the bot loops; bot errors. Result: client note "🙋 Customer needs a person …", HIGH notification, chat routed to an agent. The bot keeps replying unless "Switch the bot off when a person is needed" is on.
- **Follow-ups**: interested customers who went quiet get a 1st follow-up after 1–6 h (default 3 h) and an optional 2nd after 18–22 h (default 22 h). Max 2 per chat, only 09:00–20:30 Sri Lanka time, never after 23 h from the customer's last message (WhatsApp 24-hour window). Stops when the customer orders, says no, a handover happens or manual mode is on.
- **Ads**: when the customer came from an ad or a shared post, the prompt gets "The ad they clicked (this is the shop's OWN ad)" with title, text and link, and the bot is told to start from what the ad offers and never say the shop doesn't sell it. Campaign instructions apply for 7 days after the click.
- **Knowledge** (`/ai/knowledge`): entries with category **Policy** (always in the prompt), **Style** (reply examples), anything else = FAQ (looked up). Documents: PDF / DOCX / TXT up to 10 MB, ~20,000 characters used per file, read on our server (no AI credits).
- **Review replies**: "Good reply" saves a Style example; "Teach a better reply" saves a Style example or FAQ.
- Reports (`/ai/reports`): chats → sale, orders, value, bookings, leads, handovers, follow-up results (ordered within 7 days), ratings, handover reasons, languages, channels, best sellers, busy hours, reply speed, credits per reply. History length is limited by `reports_days`.

## Catalog, delivery, orders, bookings

- **Brand** (`product.brand`, optional, max 120, migration `supabase_product_brand.sql`): form field with suggestions (`GET /products/brands`), list column + search + brand filter, import / export column `brand`, agent order catalog search. The bot gets `brand` per product: catalog lines show "Name (Brand)" (not repeated when the name has it), big-shop index lists brands per category, keyword + meaning search include it, photo matching gives it extra weight. Prompt: never invent or change a brand; brand not sold → say so, offer the closest.
- Products: **own SKU** (optional, unique per company; empty → `SKU-{id}`), **weight optional** (only for delivery by weight), variants with own price / weight / availability, "Available to order" switch (no stock counts), selling points, up to 10 add-on products. Form steps with Previous / Next; Add / Update only on the last step.
- **Product photos are files** (`src/products/product-images.ts`): `POST /products/images` (multipart `file`, ≤ 5 MB after the browser shrinks it, JPG/PNG/WEBP/GIF checked by the file bytes) → `{ url }`, a full short link `PUBLIC_API_BASE_URL/public/product-images/<companyId>-<random>.<ext>`, served publicly with long cache. Files live in `CHAT_MEDIA_DIR/products`. Old `data:image/…` photos in products are moved to files once on start (`moveInlinePhotos`); pasted data URLs are stored as files on save. Photo links (https) can be added by hand.
- **Photo notes**: on save (and up to 30 products per API start) the backend sends the first photo to the sales bot `POST /products/describe-photo` (Gemini, one line ≤ 30 words) → `product.image_notes` (+ `image_notes_src` so the same photo isn't described twice). The catalog shows "looks: …" so the bot can match photos customers send; `search_products` also searches these notes.
- **AI cost per reply (Oct 18)**: the forced "answer now" round (3rd AI call) now stays on the cached business prompt and only adds the line "answer now with send_reply" (before, it re-sent the whole prompt uncached: ~9,400 extra full-price tokens, Rs ~2 per such reply). If the AI still asks for a lookup, a 4th call with the send_reply-only config answers (rare). The prompt asks for several lookups together in one step. Customer photos: fingerprint first – our own photo needs no AI call at all.
- **Customer photo → product** (`src/sales-bot/photo-match.ts`, bot `app/photos.py`):
  1. **Fingerprints** (no AI): every product photo gets perceptual hashes on save and on API start (`product.image_hashes`, bot `POST /photos/fingerprint`: pHash + dHash + 8×8 colour grid of the photo, trimmed and centre crops). A customer photo is hashed too, incl. cut-outs and the picture block of a screenshot. Same shape (≤ 9 of 64 bits) **and** same colours (8 most different grid cells ≤ 30) → **exact**: it is our photo. The colour check keeps the red and the blue version of the same design apart. Test set: 0 false matches in 4,500 pairs.
  2. Otherwise **AI look** (`/photos/analyze`: item, colours, pattern, text/brand, search words) → the 6 closest products by words (name, category, description, photo notes, options; near fingerprints get a bonus) → **AI side-by-side compare** (`/photos/compare`, customer photo + up to 15 real product/option photos, strict "same item" rules).
  3. Decision: same item ≥ 85% and no rival within 10 → **likely**; anything ≥ 60% or two look-alikes → **unsure** (the 2–3 closest are sent with names, the bot asks); else **none** (closest offered). Payment slips / selfies → **not_product**. The same photo on two products → unsure.
  4. Result saved on the message (`bot_message.media_note`, `media_match`), shown in the inbox, used in the chat history and when someone replies to that photo (`[replying to: "[photo: …]"]`); re-used, not re-checked. The bot gets `context.photo_matches` → "CUSTOMER PHOTO CHECK" in the notes; the engine always sends the matched / candidate photos itself.
  5. Cost: 1–2 extra AI calls per customer photo (recorded in `bot_ai_usage`); fingerprint hits use no AI.
- **Bot photo sending**: every photo carries a label "📷 Name – option – Rs price" (WhatsApp caption; Messenger / Instagram a text line first) and is saved with that text + `media_note`. Order: matched product (2 photos), unsure candidates (1 each), the AI's choice (3), products named in the reply (2). Not repeated within 10–15 min (named-in-reply: 24 h). WEBP / GIF / unknown types are converted to JPEG by the bot (`/photos/jpeg`) – WhatsApp Cloud only takes JPEG / PNG. Photo links the AI writes in its reply (placehold.co, our product-image links, .jpg/.png…) are removed from the text and sent as real photos of that product; when the AI chose no photos, up to 2 products named in the reply get their photos. Each photo is sent once per chat. Own photos are read from disk (no download).
- **Import**: Excel or CSV. **Sample file** = `GET /products/import/template` (xlsx with example rows + "How to fill"). Only `name` is required; empty category → General; matching **SKU, then name** updates the product instead of adding; rows without a name are skipped with a warning; result = created / updated / warnings.
- Product list: 50 per page (50/100/200/500) with page controls.
- Services: name, price, price note, duration, description, "Offer to customers", "Available right now".
- Delivery zones: fee per area, `*` = everywhere else, optional weight rule (first kg included + each extra kg; counting = round up (default) / nearest / exact), "Free delivery from (Rs)". No match → the bot says the team will confirm the fee.
- Orders: Pending → Confirmed → Processing → Shipped → Delivered, or Cancelled. Status templates send a WhatsApp message on change. Invoices are PDFs. Agents can change their own orders (see Team and routing); every change/delete is in the Activity log.
- Bookings: Requested → Confirmed → Done, or Cancelled.

## CRM

- Stages: New → Contacted → Qualified → Proposal → Won / Lost. The bot only moves a chat forward (contacted when it replies, qualified on interest, proposal while booking, won on order/confirmed booking, lost on cancel reason). Won and Lost freeze the stage. Flows and forms can set the stage too.
- Contacts: import CSV (`phone` required; name, email, tags with `;` or `|`; 07x → 947x), export CSV (~10,000 rows), bulk actions on up to 500.
- Tasks: types, priorities, due dates, reminder 1 hour before due.
- Labels (organization labels on chats) are separate from tags.

## Phone notifications (Web Push)

- No native app needed: the web app is installable (`manifest.webmanifest`, icons) and `public/sw.js` shows push notifications and opens the chat on tap.
- Backend `src/mobile/web-push.ts`: `GET /push/web` (public key + devices), `POST /push/web/subscribe`, `PATCH /push/web/mode`, `DELETE /push/web/subscribe`, `POST /push/web/test`. Table `web_push_subscription` (one row per browser).
- VAPID keys: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`, or generated once and stored in `platform_setting.web_push_vapid`. **Never change the keys** – every device would have to turn notifications on again.
- The push timer (`PUSH_TICK_MS`, 10 s) sends: new inbound messages → assigned agent (always) and owner (mode `all`, or `attention` = only when the bot is off / manual / unassigned); MEDIUM / HIGH `bot_notification` alerts → owner (orders, handovers, credits, **ad_lead** …). Dead browsers (404/410) are removed; other errors are kept in `last_error`.
- iPhone: only iOS 16.4+ from the home-screen app (Safari tab cannot subscribe). The UI shows the steps.
- The native app (Firebase, `FCM_SERVICE_ACCOUNT_JSON`) still works in parallel when configured.

## Customer insights (visits and groups)

- Page **CRM → Customer insights** (`/crm/insights`, owner only, package feature `crm`). API `GET /crm/insights?days=&platform=` and `POST /crm/insights/tag` (code: `backend/src/crm/insights.ts`).
- **Visit** = first inbound message, an ad click (`marketing_ad_click`), or an inbound message after **72 h** of silence (`RETURN_GAP_HOURS`). Starts within 30 minutes are merged (ad click + its first message = one visit). A visit ends at the next visit (max 28 days).
- **Visit result** from what happened inside the visit: orders (not cancelled), bookings (not cancelled/rejected), `lead_stage_event` changes to won / lost / qualified-proposal, cancelled orders (= lost), any reply (= talking), else no answer.
- **Groups** (first match wins): in talks now (last visit open, last message < 7 days) → loyal (2+ won visits, last won) → repeat buyers no order last time → bought once (last visit) → bought before not this time → lost again and again → lost once → came many times never bought → went quiet.
- **Save as tag** adds a lowercase tag to `crm_contact.tags` of everyone in the group (for broadcasts / audiences / filters).
- One person on two channels = two customers (WhatsApp and Messenger ids are different).
- **Stage history**: table `lead_stage_event` is filled by a database trigger on every `bot_conversation.lead_stage` change (from any code path). Older chats were back-filled once with their stage at their last customer message.

## Automation flows and forms

- Triggers: first message (also when a customer comes back after N days), keyword (contains / exactly / starts with), came from an ad (campaign ids), comment on a post (FB / IG, optional keywords, optional public reply; Meta allows one private message per comment within 7 days). Ad flows run before keyword and first-message flows.
- Steps (max 40): message, photo, video, buttons (up to 10 – WhatsApp shows 3 buttons, more become a list, 20 characters per button), form (in chat or as a link), wait (1 s – 7 days), add tag, lead stage, hand over (AI or team), end.
- Forms: up to 25 questions; types short/long answer, phone, email, number, date, one choice, several choices, address, photo. Can save answers to the contact, add tags, move the lead stage. Public page `/f/:slug` (uses `APP_PUBLIC_URL`).
- **Forms in chat (fixed in October)**: one clean message per question: intro, "📝 *Form title* – N quick questions. Send *stop* any time to cancel.", then "*1/N* Question?" with a short hint. The known name and WhatsApp number (shown as 0…) are offered as tap buttons; choices are buttons (or a numbered list – reply "1", "2"…). Wrong answers are asked again with ⚠️. Stop words: stop, cancel, exit, quit, nevathanna, epa. After the 3rd invalid answer the team takes over. At the end the customer gets a summary and the thank-you message.

## Marketing

- **Templates**: created in the app and sent to Meta for approval. Meta's sample `hello_world` is marked as a sample and **cannot** be used for broadcasts (error #131058 – only works from Meta's test number).
- **Broadcasts**: Cloud API only, text templates only, audience by tags / except tags / stage, schedule, 25 per batch every 15 s, monthly limit `broadcasts_per_month`. Customers who reply STOP (also Sinhala/Tamil words) never get broadcasts again. Failures are explained in plain words with a fix, and the most common problem is shown on top.
- **Campaigns**: an offer + instructions for the AI, linked to ad ids / Meta campaign ids and products. The bot uses it for customers from those ads for 7 days.
- **Links & QR**: short links (`/l/:slug`, `SHORT_LINK_BASE_URL`) that open WhatsApp / m.me / ig.me with a ready message; counts clicks, chats, orders.
- **Ads & leads**: every chat that came from an ad, grouped by ad: people, orders, bookings, won, lost, value, spend, ROAS, cost per win, click-to-sale time. One ad → every person and their outcome (ordered, booked, won, lost, interested, talking, no answer).
  - **Result per click**: only orders, bookings and stage changes **after** the click count (window: first click → 28 days after the last click on this ad, or the person's next click on another ad). An old buyer clicking again is not a win; they get `bought_before` + `prior_orders` ("Bought before" badge).
  - A new ad click resets a **won / lost** chat to **new** (`captureReferrals`), recorded in `lead_stage_event`.
- **Messenger / Instagram ad detection** (in order): `referral` on the event / message / postback (`messaging_referrals` must be subscribed on the Page **and** in the app); if missing and the customer **replied to a Page message we don't have** (`message.reply_to.mid`), the API reads it from Graph (`GET /{mid}?fields=message,attachments,shares,from,created_time` with the Page token). A Page card with a picture/link from the last 3 days = **ad / post card** → saved as an ad click with `source_type = 'card'`, `ad_id = card-<hash of text>` (same card text = same row), picture copied to our media store. The card is always inserted into the chat as its own Page bubble (source `meta-context`) so the chat looks like the customer's app. **No reply_to and no referral** (ads with a welcome message): when an inbound message comes after 30+ quiet minutes, the API reads the Page conversation (`GET /{page-id}/conversations?platform=&user_id=` → last 10 messages) and inserts every Page message of the last 24 h we don't have (ad card, greeting); the newest one with a picture/link becomes the ad lead. Instagram story replies insert "📖 Your story" with the picture.
- **Opened from an ad before typing** (`messaging_referrals` event without a message): the contact and chat are created at once, the Page messages of the last 24 h (ad card, greeting) are read from the conversation and inserted, the click is recorded and an `ad_lead` notification is created (→ push to the owner).
- **What Meta sent lately**: the last 30 Messenger/Instagram events per company are kept in memory (types only, no text) and shown in the connection check → Technical details. `META_WEBHOOK_LOG=1` writes the full raw events to the API log (contains customer text – only switch on while debugging).
- **Meta ads**: campaigns from the connected ad account (spend, clicks, orders, sales, cost per order, ROAS), pause and change budget. If the selected ad account has no ads, an **account switcher** suggests the account that actually runs the Page's ads.
- **Audiences**: send a CRM group (hashed) to Meta as a Custom Audience.
- **Marketing settings**: connect the Meta ad account; **Conversions API** (dataset/pixel id, optional test code) sends Lead and Purchase events back to Meta.
- **Overview**: sources (ads, posts, links, direct), top ads, ad leads, setup checklist, broadcasts and campaigns summary.

## Social

- Comments from Facebook and Instagram: reply publicly, send privately, hide/unhide, delete, mark done. AI on new comments: Off / Suggest a reply / Reply automatically (+ private message, hide spam).
- Create post (AI caption in English / Sinhala / Singlish / Tamil, up to 10 photos, Instagram needs a photo and max 2,200 characters), schedule, content calendar, published posts (edit Facebook only), analytics, saved replies, Page & Instagram.
- Long video uploads need Apache `ProxyTimeout` ≥ 120 s (see Operations).

## Billing for companies

- Billing & plan: current package, credits used, top-ups, payments, invoices.
- Card via PayHere (optional auto-renew; can only be switched off by the customer) or bank transfer (upload slip → super admin approves).
- Paying the same package adds time to the end date; a new package starts a fresh credit month; yearly adds 12 months.

## Website, docs and legal pages

- Public pages: `/`, `/pricing`, `/guides`, `/docs` (the full user guide with search and PDF download), `/contact`, `/privacy`, `/terms`, `/data-deletion`, form pages `/f/:slug`.
- The user guide PDF is `frontend/public/downloads/agent-metra-user-guide.pdf`. Rebuild it after changing the guide: `npm run docs:pdf` (see chapter 6).
- Branding (name, logo, colours, contact details) comes from Super admin → Branding and is used everywhere, including the docs.
