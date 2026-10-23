# Marketing

The **Marketing** menu helps you bring customers back and see what your marketing earns: WhatsApp broadcasts, templates, campaigns for the AI, short links and QR codes, ads results and Meta audiences. Some pages depend on your package.

## Marketing overview

One page with:

- **Where customers come from** – Facebook / Instagram ads, shared posts, links & QR codes, and direct messages.
- **Top ads** – the ads that bring the most chats and sales.
- **Ad leads** – recent customers from ads and what happened to them.
- **Setup checklist** – what is still missing (ad account, Conversions API, WhatsApp Cloud API, templates).
- Broadcasts and campaigns summary.

## Message templates

WhatsApp only lets businesses **start** a conversation (or write after 24 hours) with a **template** approved by Meta.

1. **Marketing → Message templates → New template**. Start from an example (Discount offer, Back in stock, Festival greeting, Appointment reminder…) or write your own.
2. Use `{{1}}`, `{{2}}` for values like the customer's name, and give an example for each.
3. Send it to Meta. Approval usually takes minutes (sometimes up to 24 hours).

> **Warning:** **hello_world** is Meta's sample template. It only works from Meta's test number – sending it from your own number fails with error **#131058**. It is marked as a sample and can't be chosen for broadcasts. Create your own template instead.

## WhatsApp broadcasts

Send an approved template to a group of customers.

1. **Marketing → WhatsApp broadcasts → New broadcast**.
2. **Name** (only for you), **Approved template**, and the audience: customers **with tags**, **except tags**, and/or a **stage**. Optional **campaign** and **schedule**.
3. **Send now**, **Schedule** or **Save draft**. You can **Cancel** a running broadcast (messages already sent stay sent).

After sending you see delivered, read and replied, and every failed message with the reason **in plain words** and **how to fix it**. The most common problem is shown at the top.

Good to know:

- Broadcasts need WhatsApp on the official **Cloud API**.
- Only text templates (no photo or video header) for now.
- Customers who reply **STOP** (also in Sinhala and Tamil) never get broadcasts again.
- Meta charges a small fee per marketing message, and limits how many marketing messages one person gets. Send to customers who know your business.
- Your package may limit broadcasts per month.

## Campaigns

A campaign tells the AI about a special offer:

- **Campaign name**, **Offer** (what the AI tells customers), **Instructions for the AI**, a **contact tag**, start and end dates, status (Active / Paused).
- Link it to **ad IDs or Meta campaign IDs** and to products.

Customers who come from those ads (in the last 7 days) get answers based on the campaign.

## Links & QR codes

Make a short link and QR code that opens a chat with you with a ready message (for example "Hi, I saw your poster").

- **Opens**: WhatsApp, your Facebook Page (m.me) or Instagram (ig.me).
- **Ready message**, optional **contact tag** and **campaign**, and the short code (can't be changed later).
- Download the QR as **SVG** for printing (print at least 2.5 cm wide).
- See **clicks, chats and orders** for every link. Switch a link off any time.

Use them on posters, flyers, packaging, your shop counter and in your bio.

## Meta ads

**Marketing → Meta ads** shows your Facebook / Instagram campaigns from your connected ad account: spend, link clicks, contact clicks, orders, sales, cost per order and **ROAS** (2× or more is shown in green). You can **Pause** a campaign or change its **Budget** – this changes it in Meta Ads Manager.

**Ads not showing?** If the connected ad account has no ads for your Page (for example a personal ad account), you see "**Your ads may be in another account**". Press **Show that account** to switch, or use the **ad account switcher** at the top.

## Audiences

Send a group of customers (by tags or stage) to Meta as a **Custom Audience** – for example to show ads to your buyers again or to build a lookalike audience. Phone numbers are hashed before they are sent.

## Marketing settings

This page connects your marketing to Meta:

1. **Connect with Meta** and choose your **ad account** – needed for Meta ads, spend, ROAS and audiences.
2. **Conversions API** – enter your **dataset (pixel) ID** (and an optional test event code). {{brand}} then tells Meta which ad chats became **leads** and **purchases**, so Meta shows your ads to people who buy. The event log shows the last events sent.
3. A checklist shows what is connected (ad account, dataset, WhatsApp Cloud API).
