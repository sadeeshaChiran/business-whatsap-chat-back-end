# Ads and leads – what your ads really bring

**Marketing → Ads & leads** shows every customer who came from your Facebook or Instagram ads (and shared posts), grouped **ad by ad**, with what happened next: orders, bookings, won, lost.

## How a chat is linked to an ad

When someone taps **Send message** / **WhatsApp** on your ad (Click-to-WhatsApp, Click-to-Messenger, Click-to-Instagram ads, or a boosted post with a message button), Meta tells {{brand}} which ad it was – the ad ID, title, text, photo and link. {{brand}} saves it **before the bot replies**, so:

- the chat gets the **📣 Ad** chip and the ad card in the Inbox (see [Inbox](#inbox)),
- the AI bot answers about **that ad's offer** first,
- the customer is counted for that ad.

A customer who types your number by hand is not linked to an ad. Orders, bookings and wins are counted for the ad for **28 days** after the customer's last click on it – or until they click **another** ad (then the newer ad gets the sale).

### Messenger and Instagram ads

- Click-to-Messenger and Instagram ads are linked the same way when Meta sends the ad details ("ad clicks" must be on – the **connection check** in Channels → Messenger shows it and has a **Fix it** button).
- When Meta sends no ad details – common for ads with a **welcome message** – {{brand}} reads the chat from Meta when the customer writes: the ad card Meta showed them (and the greeting) is brought into the chat, and the chat counts as a lead from that card. The same happens when the customer **replies to the card**. These rows show as **Ad / post (customer replied to it)** and are grouped by the card's text (for example "new one").
- To see what Meta actually sends, open Channels → Messenger → **Technical details → What Meta sent lately** (types only, never message text).

### Results only count what happened after the click

The result of each person is measured **from this click on**. A customer who bought from you last month and now clicks an ad but does not order shows as **Talking** (or Interested / Lost) – not as Won. These people get a **Bought before (N×)** badge so you can see they are returning buyers.

When a customer who was already **Won** or **Lost** clicks a new ad, their stage starts again at **New** – it is a new deal. Their earlier results stay in their history (see [CRM – Customer insights](#crm)).

### Customers who come from several ads

If the same customer clicks two or more ads, every click is saved. The Inbox shows the **latest ad on top** and the **earlier ads** below it, and each message shows the ad it came from. In Ads & leads the customer is counted for each ad they came from.

## The ads list

Choose the period: last 7, 30 or 90 days or last 12 months. The tiles on top show the totals (people, won, lost, sales, spend). For every ad:

| Column | Meaning |
| --- | --- |
| **Ad** | Photo, title, campaign and channel. **Shared post** = a post someone shared with the customer. |
| **People** | Customers who started a chat from this ad. |
| **Answered** | Customers who got an answer (bot or team). |
| **Won** | Customers who ordered, booked or were marked won. |
| **Lost** | Customers marked lost. |
| **Orders · bookings** | Number of orders and bookings. |
| **Sales** | Money from their orders. |
| **Spend** | What the ad cost (when your ad account is connected). |
| **Per person** | Spend ÷ people. |
| **ROAS** | Sales ÷ spend. 2× means Rs 2 back for every Rs 1. |

## One ad in detail

Click an ad to see:

- The ad (photo, title, text, link) and the tiles, including **Cost per win** (spend ÷ customers who bought or booked).
- **From click to sale** – a funnel: clicked to chat → people → got an answer → interested or won → won, with the **% of people** at each step.
- **Every person** from this ad: when they clicked, their **result** (**Ordered**, **Booked**, **Won**, **Interested**, **Talking**, **No answer yet**, **Lost**), their orders and bookings, sales and last message – click to open their chat.

Use it to see which ads bring buyers and which only bring questions, then move your budget to the best ads.

## Tips

- Connect your **ad account** in Marketing settings to see spend and ROAS.
- Turn on the **Conversions API** so Meta learns who buys.
- Use **Campaigns** to give the bot special instructions for an ad (for example "the 20% discount is only for orders above Rs 5,000").
- Use a **"Came from an ad"** flow to send a welcome message with buttons for ad customers.
