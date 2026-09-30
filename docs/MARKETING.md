# Agent Metra – Marketing tools (Part G)

Page: **Marketing** (company admins). Migration `supabase_marketing.sql` (startup). API `/marketing/*`.

| Part | What | Needs |
|---|---|---|
| 1 Ad tracking | The Meta `referral` of Click-to-WhatsApp / Messenger / Instagram ads is saved on the chat (`bot_conversation.ad_*`, incl. `ctwa_clid`). **Ad results**: chats, people, orders, bookings, sales per ad; orders count within 28 days after the click. | nothing |
| 2 Ads dashboard | **Campaigns**: spend, impressions, clicks, chats started (Meta) + chats / orders / sales (Agent Metra) → cost per chat / order, **ROAS**. Ad and campaign names cached in `marketing_ad_cache`. | Meta `ads_read` |
| 3 Manage ads | Pause / start campaigns, change the campaign daily budget (only campaigns of the connected ad account). | `ads_management` |
| 4 Conversions API | New orders → `Purchase` (value, LKR); lead / booking replies → `LeadSubmitted`; only for chats from an ad (28 days); `action_source = business_messaging` with `ctwa_clid` (WhatsApp) / page-scoped id (Messenger) / IG id (Instagram). Never sent twice (`marketing_capi_event`). | Dataset id + access token (Events Manager) |
| 5 WhatsApp broadcasts | Approved text templates to CRM groups (tags / except tags / stage), `{first_name}` `{name}` `{phone}`, send now / schedule / draft, 25 messages per 15 s, stats sent / delivered / read / replied / failed, copy in each chat. **STOP / unsubscribe / opt out** replies → `marketing_optout`, never sent again. | WhatsApp on Meta Cloud API + approved **marketing** templates (Meta fee per message) |
| 6 Audiences | CRM group → Meta **Custom Audience**; phone (with country code) and email **SHA-256 hashed** on the server. | `ads_management` |

## Setup
1. Meta Developers → your app → **App Review**: request `ads_read`, `ads_management` (and `business_management`).
   Until approved, only people with a role in the app can connect.
2. Meta app → Facebook Login → Valid OAuth Redirect URIs: `{PUBLIC_API_BASE_URL}/public/marketing/meta/callback`.
3. Marketing → Settings → **Connect with Meta** → choose the ad account.
4. Conversions API: Events Manager → dataset → Settings → *Generate access token*; paste the dataset id + token, use a
   *test event code* first and check **Test events**, then remove it and switch on.
5. Broadcasts: create a template (category *Marketing*) in WhatsApp Manager and wait for approval.

## Tested (fake Meta server)
Referral parsing (WhatsApp with ctwa_clid, Messenger by sender, no referral), ad results with names, campaigns with
spend / ROAS, pause + budget + blocked for another ad account, approved templates only, audience preview, broadcast
(5 sent, 1 undeliverable with Meta's reason, delivery / read stats, chat copy), STOP opt-out, Conversions API Purchase
with ctwa_clid, audience created with hashed data, admin-only access. Not tested against the real Meta API.
