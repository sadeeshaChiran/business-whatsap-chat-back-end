# Agent Metra – Social (Facebook Page + Instagram)

Menu **Social** (company admins, package switch `social` – off on Free by default, super admin can change it).
Uses the Page connected in Channels → Messenger (and its linked Instagram professional account).

## Comments
- Facebook + Instagram comments in one list (To answer / Replied / Hidden / Done / All, search, platform filter).
- Real time through the Meta webhook (Page `feed`, Instagram `comments`) + "Load from Meta" (last 15 posts each).
  Our own replies on Meta mark the comment as answered.
- Reply publicly, **private reply** (one message to the commenter's Messenger / Instagram inbox – Meta allows one per
  comment, within 7 days; the chat then continues in the Inbox), like (Facebook only), hide / unhide, delete, "done".
- **AI**: suggest a public reply + a private message (uses products, prices, availability, policies; never asks for
  personal details in public; spam is detected). Settings: AI off / suggest / reply automatically (+ private message,
  + hide spam). AI uses the company's credits like chat replies.

## Posts
- Facebook and Instagram posts with likes / comments / shares; edit + delete Facebook posts (Instagram's API does not allow it).
- Create: Facebook and / or Instagram, text, link, 1–10 photos (JPG / PNG, carousel on Instagram), **AI caption writer**
  (English, Sinhala, Singlish, Tamil, with hashtags), **schedule** (published by the server every minute; a failure
  creates a notification). Photos are stored by Agent Metra and Meta downloads them from a signed public link
  (needs PUBLIC_API_BASE_URL).

## Analytics (7 / 28 / 90 days)
Facebook: reach, engagement, page views, new followers + reach per day. Instagram: reach, profile views, accounts
engaged, interactions, website clicks. Top posts, best time to post (Sri Lanka time, from recent posts), comment stats
(answered, by AI, average answer time, private messages, chats from comments). Each metric is asked separately – a
metric Meta has retired is skipped instead of breaking the page.

## Page & Instagram
Profile, followers, likes / following / posts, bio, links; warning + "Reconnect Page" when permissions are missing.

## Meta setup
- App Review: `pages_manage_engagement`, `pages_read_user_content`, `pages_manage_posts`, `read_insights`,
  `instagram_manage_comments`, `instagram_content_publish`, `instagram_manage_insights` (added to the default
  META_OAUTH_SCOPES – if you set META_OAUTH_SCOPES yourself, add them). Each business reconnects its Page once.
- Webhooks: Page → `feed` (subscribed automatically when the Page is connected), Instagram → `comments` (app dashboard).

API: `/social/overview|settings|comments|comments/sync|comments/:id/(reply|private-reply|hide|like|done|suggest)|posts|media|caption|schedules|insights`.
Migration `supabase_social.sql`. Python bot: `/social/comment-reply`, `/social/caption` (app/social.py).
Tested end to end against a fake Meta server and a fake AI (not against the real Meta API).
