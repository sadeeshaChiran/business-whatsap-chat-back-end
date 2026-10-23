# FAQ and troubleshooting

## The bot is not replying

Check these in order:

1. **Do messages arrive in the Inbox?** If not, see "Messages don't arrive" below.
2. **AI reply** switch in the chat – is it off (Manual)? An agent may have accepted the chat. Turn it on.
3. **AI sales bot → Bot replies to customers** – is the bot on?
4. **Credits** – Billing shows 100% used, or "Your free AI bot month has ended". Buy a top-up or choose a package.
5. **Bot per customer** – the bot may be switched off for this one customer.
6. A **form or flow** is running in this chat – the bot waits until it ends.
7. The customer only wrote "ok" or "thanks" – the bot doesn't reply to these on purpose.

## Messages don't arrive

Open **Channels → WhatsApp** (or Messenger / Instagram) and press **Check again**. The connection check names the problem. Press **Fix it** when shown. If everything is green and messages still don't arrive, send a screenshot of the check to our support team.

## WhatsApp broadcast failed

Open the broadcast – every failed message shows the reason and the fix. The most common:

- **#131058 – Hello World template**: Meta's sample template only works from Meta's test number. Create your own template.
- **Not on WhatsApp / can't receive**: check the number with the customer.
- **Meta held it back** (#131049): this person got many marketing messages recently. Try again in a few days.
- **Customer stopped marketing messages** (#131050): don't send marketing to this number.

## My template was rejected

Make the purpose clear, don't start or end with a `{{1}}` value, give example values, and avoid misleading text. Edit and send again.

## I can't see my ads in Meta ads

Your connected ad account may not be the one that runs your Page's ads. Look for "**Your ads may be in another account**" and press **Show that account**, or switch the ad account at the top. You can also reconnect in Marketing settings and choose your business ad account.

## Messenger / Instagram chats from my ads look like normal chats

1. Open **Channels → Messenger** and press **Check again**. "Ad clicks are sent to {{brand}}" and "Meta app: Messenger webhook fields" must be green – press **Fix it** if not.
2. Ads with a **welcome message**: Meta usually sends no ad details. When the customer writes, {{brand}} reads the chat from Meta and brings in the ad card and greeting – the chat then shows **Came from your ad / post**. This needs the Page connected with its permissions (reconnect the Page in Channels → Messenger if the card does not appear).
3. Click your ad from another account and send a message, then look at **Technical details → What Meta sent lately**. "referral: ADS …" means Meta sent the ad. "reply to an earlier message" means the customer replied to the ad card.
4. If none of this marks the chat, send the screenshot of that list to our support team.

## A customer who bought before shows "Talking" in Ads & leads

That is correct: results count only what happened **after** that ad click. The badge **Bought before** shows they are a returning buyer. Their full history is in **CRM → Customer insights**.

## A chat from an ad isn't marked as "Ad"

Only chats started from the ad's **Send message / WhatsApp** button carry the ad. If the customer typed your number by hand or wrote later from a normal chat, Meta doesn't tell us the ad.

## The same customer came from two ads – where do I see it?

In the chat: the banner shows the **latest ad** and "came from 2 different ads" with the earlier ads below. Each message shows the ad card of the ad it came from.

## The delivery fee is wrong

Check **Delivery zones**: the area must be in the list (or add `*` for everywhere else), and every product needs a weight. Weight is rounded up by default (2.3 kg → 3 kg).

## The bot won't book a time

The time is outside your opening hours, or already full ("Bookings at the same time"). The bot offers the 3 nearest free times. Check opening hours in AI sales bot settings.

## An agent doesn't get chats

The agent must be **Online** (top bar) and not "Away" on the Team board. Check that the package has free seats.

## Instagram messages don't arrive

Your Instagram must be a **Professional** account linked to your Facebook Page, and in the Instagram app **Settings → Messages and story replies → Connected tools → Allow access to messages** must be on. Then reconnect in Channels → Instagram.

## I paid by bank transfer – when will my package start?

After we check your slip – usually within a few hours on working days. You get a notification. If the slip is rejected you see the reason and can upload a new one.

## I'm locked out

After 8 wrong passwords the account is locked for 15 minutes. Use **Forgot password** on the login page to set a new one. Too many tries in one minute show "Too many requests" – wait a minute.

## How do I get notifications on my phone?

**Settings → Phone notifications → Turn on notifications** on each phone and computer. On iPhone, first add {{brand}} to your home screen (Safari → Share → Add to Home Screen) and open it from there. See [Settings and security](#settings).

## I don't get notifications

- Press **Send a test** in Settings → Phone notifications.
- The browser must allow notifications for this site (lock icon next to the address → Notifications → Allow).
- Phone in "Do not disturb" / focus mode or battery saver can hold notifications back.
- On iPhone it only works from the home-screen app, not from a Safari tab.
- Owners: check you did not choose **Only chats that need a person** if you want every message.

## I didn't get the SMS code

- Check the mobile number (07X XXX XXXX or +94 7X XXX XXXX) and press **Send again** after a minute.
- Codes are valid for 10 minutes. Use the newest code.
- Some phones put messages from short senders in a "Promotions" or "Unknown senders" folder.
- Still nothing? Contact support – we can check if the SMS was sent.

## The bot picked the wrong product for a customer's photo

Open the chat: under the customer's photo you see what the bot found. Make sure each product (and each colour) has its **own clear photo** – two products with the same photo can't be told apart, so the bot asks the customer. Photos added or changed are checked again automatically.

## The bot sent a link instead of the photo

Photos are sent as pictures. Make sure the product has photos in **Media gallery** (an uploaded photo, or a link that starts with https://). Links that don't open a picture can't be sent – upload the photo instead.

## Do I have to enter a weight?

No. Weight is only needed when your delivery zones **charge by weight**. Without it the normal delivery fee is used.

## How do I contact support?

Use the contact details on our [Contact page](/contact). Tell us your business name, the channel, the time of the problem and send screenshots. **Never** send your password.
