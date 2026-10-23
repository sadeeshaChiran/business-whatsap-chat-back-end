# Products, services and delivery

The bot only sells what is in your catalog, at the prices you set. Keep it up to date.

## Products

**Sales → Products → Add product**. The form has four parts:

1. **Basic info** – name, price, description, category, **Brand** (optional, e.g. Casio, Nike, Bata – brands you used before are suggested), **Product SKU** (your own code, or leave it empty and we make one like SKU-123 – each code can be used once) and **Weight (kg)** (optional – only needed when your delivery fee depends on weight).
2. **Media gallery** – upload photos (up to 8 MB each, made smaller for you) or **paste a photo link** (https://…) and press **Add link**. Each photo shows its **full link** under it (copy it with the copy button). Uploaded photos are saved on our server with a short link like `…/public/product-images/12-a8f3k2q9.jpg`. The bot sends these photos to customers.
3. **Variants & inventory** – options like *Colour / Size / Pack*. Each variant can have its own price, photo, weight and an **Available** tick. Empty weight = the product's weight.
4. **Sales bot**:
   - **Show to the sales bot** – off: the bot never mentions or sells this product (it stays in your catalog).
   - **Selling points** – why customers love it (up to 2,000 characters). The bot uses these to sell.
   - **Add-on products** – up to 10 products the bot may suggest with this one.

Use **Previous** and **Next** (bottom right) to move between the parts. **Add Product** / **Update Product** appears on the last part, in place of **Next**.

**Available to order** switches a product off when it is out of stock – no stock counting needed.

**Brands**: the product list has a **Brand** column, the search finds brands, and **All brands** filters by one brand. The AI bot knows each product's brand, so "Casio watch thiyenawada?" finds the right products; it never invents a brand.

**Product list**: 50 products per page (choose 50, 100, 200 or 500). Use **Prev / Next** or pick a page number at the bottom.

### Import many products

1. Press **Sample file** on the Products page. You get an Excel file with example rows and a **How to fill** sheet.
2. Fill one row per product (or one row per option, e.g. each size). Only **name** is needed (a **brand** column is optional); category empty = *General*, weight and price are optional. Put photo links in **image_urls** (separate several with `;`).
3. Press **Import** and choose the file (Excel or CSV).
4. You see how many products were **added** and **updated**, and what to check. A row whose **SKU** or **name** already exists **updates** that product instead of adding it twice. Rows without a name are skipped.

### How the bot uses photos

- When the bot talks about a product that has photos, it **sends the photos** as real pictures – never a link in the text. Every photo carries the **product name, the option (colour) and the price** (on Messenger / Instagram a short line comes just before the photo), so the customer can tell several products apart.
- **One photo per product** normally – asking for "shirts" sends one photo of each shirt (its main photo).
- **The colour the customer names**: "white ABC t-shirt" (also *sudu eka*, *kalu eka*, සුදු, කළු …) sends **only the white photo** – never the first colour – and the bot says which other colours you have ("We also have it in Black and Navy – want to see?").
- **All photos when asked**: "all colours", "more photos", "okkoma paata", "anith colours" sends every photo of that product, each labelled with its colour.
- For this to work, add a photo to each colour in **Variants & inventory** (one photo per colour is enough – sizes of the same colour share it).
- A photo is not sent again within a few minutes; when the customer asks again later, it is sent again.
- WEBP and GIF photos are turned into JPEG automatically (WhatsApp only sends JPEG and PNG).

### When a customer sends a photo

The bot checks the photo against **your own product photos** before it answers:

| What the customer sent | What the bot does |
| --- | --- |
| One of **your** photos (forwarded, a screenshot of your post or ad, smaller, cut out) | Knows the product **for sure**, answers with its name, price and options and sends your photo of it. |
| Another photo of a product you sell | The AI compares it side by side with your real photos. Only a clear match counts. |
| Something close, but not sure (same type, colour or print not clear, two products look alike) | Sends the 2–3 closest products **with names and photos** and asks which one – it never guesses. |
| Something you don't sell | Says you don't have that exact item and offers the closest one. |
| A payment slip, selfie or screenshot of text | Answers about what it is – no product search. |

In the inbox the customer's photo shows what the bot found, for example **🔎 Our product: Blue Classic Watch (our own photo)**.

**Replying to a photo**: when the customer replies to a photo ("mekata kiyada?") the bot knows which product that photo is – a photo the bot sent, or a photo the customer sent earlier.

> **Tip for best results:** add clear photos of every product and every colour / option (option photos in **Variants & inventory**). The more of your own photos the bot knows, the more often it is sure.

## Services

**Sales → Services** (for businesses that take bookings):

- Service name, **Price (Rs)**, price note (for example "from"), **Duration (minutes)**, description.
- **Offer to customers** – off: the bot never mentions it.
- **Available right now** – off: the bot suggests another service.

## Delivery zones

**Sales → Delivery zones** sets the delivery fee per area.

1. Add an **Area** (district or city), the **Delivery fee (Rs)** (0 = free) and the **Delivery time** (for example "2–3 days").
2. Add **everywhere else** (`*`) for all other areas.
3. Optional **Charge by weight**:
   - **First kg (in the price above)** – for example 1 kg included.
   - **Each extra kg (Rs)** – for example Rs 100.
   - **How to count the weight**: *Round up* (default, 2.3 kg → 3 kg), *Nearest kg* or *Exact weight*.
4. Optional **Free delivery from (Rs)** – orders at or above this amount get free delivery.

**Example**: Colombo Rs 350 including 1 kg, Rs 100 per extra kg. An order of 2.3 kg → 3 kg → Rs 350 + 2 × Rs 100 = **Rs 550**.

> **Note:** The delivery fee is always calculated by the system, never by the AI. If the customer's area is not in your list and there is no `*` zone, the bot tells the customer your team will confirm the fee.
