# Shop API – connect your own system

Your own system (POS, website, ERP, stock software) and {{brand}} can work together by themselves:

- **Products and stock update by themselves.** Your system sends new products, prices and stock counts. A product with 0 stock becomes *Unavailable* by itself, so the AI bot stops selling it, and it becomes *Available* again when stock comes in.
- **Orders reach your system by themselves.** Every order the AI bot or your team takes is sent to your system within about 20 seconds (webhook).
- **Order status changes by itself.** When your system ships or delivers an order, it tells {{brand}}. The customer gets the status message on WhatsApp, and the order history is kept.

This guide is for the developer who connects your system. Everything here works with any language that can send HTTPS requests: PHP, Node.js, Python, C#, Java and others.

## Before you start

1. Log in as the **business owner** and open **Settings → Shop API & webhook**.
2. Copy the **Base URL**. It looks like `https://<api-host>/v1/api/open`.
3. Click **Create key**. The key starts with `am_live_` and is shown **only once**. Keep it in your server settings, never in a website or app that customers can open.
4. Send the key with every call, in one of these two headers:

```
Authorization: Bearer am_live_xxxxxxxxxxxxxxxxxxxxxxxx
X-API-Key: am_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

Check that the key works:

```
curl https://<api-host>/v1/api/open/me -H "Authorization: Bearer am_live_xxx"
```

Answer: `{ "company": { "id": 16, "name": "Chu.lk" } }`

### Rules for every call

| Rule | Detail |
|---|---|
| Format | JSON in, JSON out. Send `Content-Type: application/json`. |
| Speed limit | Up to 120 calls a minute per key. Use the bulk calls (500 products or 500 stock lines a call) for big syncs. |
| Who you are | The API acts as the business owner, so the same rules as the dashboard apply (package limits, stock, booking times). |
| Errors | `400` wrong data (the message says what), `401` wrong or removed key, `404` not found, `409` booking time taken, `429` too many calls (wait a minute). |
| Test customers | Numbers starting with `999` are test chats. Their orders are never listed or sent to you. |

## Products

### Add or update products – `POST /products`

Send up to 500 products in one call. A product with the same **sku** is **updated**, otherwise it is **added**. On an update, the fields you leave out keep their value, so a price change needs only `sku` and `price`.

```json
{ "products": [
  { "sku": "94273449", "name": "Water Bottle - 1600ml", "category": "Kitchen item", "price": 1295,
    "description": "1.6 litre sports bottle", "weight": 0.4, "available": true, "quantity": 25,
    "selling_points": "Leak-proof\nLightweight and durable",
    "image_urls": ["https://your-shop.lk/images/bottle-1.jpg", "https://your-shop.lk/images/bottle-2.jpg"] },
  { "sku": "94273441", "price": 895 },
  { "sku": "SHOE-01", "name": "Baby Shoes", "category": "Shoes", "price": 1800,
    "variants": [
      { "name": "Size", "value": "0-6 months", "sku": "SHOE-01-S", "quantity": 4 },
      { "name": "Size", "value": "6-12 months", "sku": "SHOE-01-M", "price": 1950, "quantity": 0 } ] }
]}
```

| Field | Meaning |
|---|---|
| `sku` | Your product code. Use the same code every time. |
| `name` | Needed for a new product. |
| `price` | Price in rupees. |
| `available` | `true` / `false`. The bot never offers an unavailable product. |
| `quantity` | Stock count. Stock counting switches on by itself. `0` makes the product Unavailable. |
| `variants` | Options such as size or colour. Each can have its own `sku`, `price`, `available` and `quantity`. |
| `image_urls` | Up to 20 public photo links. The photos are copied to {{brand}}. |
| `selling_points` | Short lines the bot uses to sell, one per line. |
| `show_to_bot` | `false` hides the product from the bot. |
| `category`, `brand`, `description`, `weight` (kg) | As in the dashboard. Weight is used for the delivery fee. |

Answer:

```json
{ "created": 1, "updated": 2, "errors": 0,
  "results": [ { "sku": "94273449", "id": 7240, "action": "created", "stock": 25 },
               { "sku": "94273441", "id": 7202, "action": "updated" },
               { "sku": "SHOE-01", "id": 7241, "action": "created", "stock": { "0-6 months": 4, "6-12 months": 0 } } ] }
```

One bad product never stops the others. Check `results[].error` and `results[].stock_error`.

### Read your products – `GET /products`

See what {{brand}} has, for example to check a sync.

```
GET /products?page=1&limit=100
GET /products?sku=SHOE-01-M
GET /products?search=bottle
GET /products?since=2026-11-20T00:00:00Z
```

`limit` can be up to 500. `since` returns products changed after that time. A variant SKU finds its product.

```json
{ "total": 3828, "page": 1, "limit": 100,
  "products": [ { "id": 7240, "sku": "94273449", "name": "Water Bottle - 1600ml", "price": 1295, "available": true,
                  "stock": 25, "weight": 0.4, "image_url": "https://…", "updated_at": "…", "variants": [] } ] }
```

`stock` is `null` when stock counting is off for that product.

### Stock of one product – `PUT /products/{sku}/stock`

```json
{ "quantity": 12 }
{ "quantity": 5, "mode": "add", "note": "GRN 1045" }
{ "quantity": 0, "variant_value": "6-12 months" }
```

- `mode: "set"` (the default) means the stock is now exactly this number. Use it for a full count from your system.
- `mode: "add"` means stock received (positive) or removed (negative).
- A **variant SKU** in the URL changes only that option. You can also send `variant_value`.
- Stock counting switches on by itself. At `0` the product or option becomes **Unavailable**. When stock comes again it becomes **Available**. The owner also gets low-stock and out-of-stock alerts.

Answer: `{ "sku": "94273449", "product_id": 7240, "option": null, "stock": 12, "available": true, "changed": true }`

### Stock of many products – `POST /stock`

The easiest way to keep stock in step: send all counts every few minutes, or send only the ones that changed. Up to 500 lines a call.

```json
{ "items": [
  { "sku": "94273449", "quantity": 25 },
  { "sku": "94273441", "quantity": 0 },
  { "sku": "SHOE-01-M", "quantity": 3 },
  { "sku": "94273440", "quantity": 10, "mode": "add" }
]}
```

Answer:

```json
{ "updated": 3, "errors": 1,
  "results": [ { "sku": "94273449", "ok": true, "stock": 25, "available": true, "changed": false },
               { "sku": "NOPE-1", "ok": false, "error": "No product with SKU NOPE-1." } ] }
```

Sending the same count again changes nothing (`"changed": false`), so a sync can safely run again.

### Available / not available only – `PATCH /products/{sku}/availability`

`{ "available": false }` – for a shop that does not count stock. A variant SKU switches only that option, or send `"variant_value": "6-12 months"`.

### Remove a product – `DELETE /products/{sku}`

## Orders

Every order has two numbers:

- `order_no` is **your shop's order number** (1, 2, 3 …). Customers and your team see it as **#12**.
- `id` is the internal number. Both always point to the same order.

### Read orders

```
GET /orders?status=Pending&since=2026-11-20T00:00:00Z&limit=50
GET /orders/{id}
GET /orders/number/{order_no}
```

`since` returns orders changed after that time, newest first. `limit` can be up to 200.

```json
{ "id": 5301, "order_no": 12, "status": "Pending", "channel": "whatsapp", "created_by": "bot",
  "customer": { "name": "Nimal Perera", "phone": "94771234567", "address": "10 Temple Road, Kalutara", "area": "Kalutara" },
  "payment_method": "COD", "delivery_fee": 425, "total": 2470, "weight_kg": 1.1, "note": null, "invoice_url": "https://…",
  "items": [ { "product_id": 7202, "sku": "94273441", "name": "Table Cloth Golden Desing", "variant": null,
               "quantity": 2, "unit_price": 895, "total_price": 1790 } ],
  "created_at": "2026-11-21T09:12:00Z", "updated_at": "2026-11-21T09:12:00Z" }
```

`created_by` is `bot` (the AI bot), or `agent` / `admin` (your team).

### Change the status

```
PATCH /orders/{id}/status
PATCH /orders/number/{order_no}/status
```

```json
{ "status": "Shipped" }
{ "status": "Delivered", "notify_customer": false }
```

Statuses: `Pending`, `Confirmed`, `Processing`, `Shipped`, `Delivered`, `Cancelled`.

- It works the same as the dashboard: the status history is kept, stock is updated (a cancelled order gives its stock back), and **the customer gets the status message** on WhatsApp / Messenger.
- `"notify_customer": false` changes the status without a message to the customer.
- The same status again changes nothing and sends no second message (`"changed": false`).
- A status you set through the API is not sent back to you by the webhook.

Answer: `{ "order": { …order… }, "changed": true, "customer_message": "Hi Nimal, your order #12 is on the way 🚚" }`

## Bookings (service businesses)

- `GET /bookings?status=requested&since=…`
- `PATCH /bookings/{id}/status` `{ "status": "confirmed" }` – `requested`, `confirmed`, `done`, `cancelled`. A time that is already taken is refused with `409`, like in the dashboard.

## Webhook – orders reach your system by themselves

1. In **Settings → Shop API & webhook**, add your URL (for example `https://your-system.lk/agentmetra/webhook`).
2. Choose the events and click **Save & switch on**.
3. Click **Send a test**. Your URL gets a `ping` event.

Only orders and bookings made after you switch it on are sent, not the old ones.

| Event | When |
|---|---|
| `order.created` | A new order (AI bot or team) |
| `order.status_changed` | The status changed in the dashboard, the app or by the bot. `data.previous_status` has the old status. |
| `booking.created`, `booking.status_changed` | The same for bookings |
| `ping` | *Send a test* |

What we send:

```
POST https://your-system.lk/agentmetra/webhook
Content-Type: application/json
X-AgentMetra-Event: order.created
X-AgentMetra-Signature: t=1763716320,v1=5f2c9a…

{ "id": "evt_8c1f…", "event": "order.created", "created_at": "2026-11-21T09:12:20Z", "data": { …order… } }
```

- Answer with any **2xx** within 10 seconds. Otherwise we try again after 1, 2, 4, 8 … up to 60 minutes (12 times), in order.
- **Check the signature** so nobody else can send you fake orders: `v1 = hex( HMAC_SHA256( secret, t + "." + raw_body ) )`. Check also that `t` is recent (within 5 minutes). The secret starts with `whsec_` and is shown in the settings.
- The same event can come twice (for example after a timeout). Use `data.id` with `event` to skip a duplicate.

## Examples

### PHP (Laravel) – receive orders

```php
Route::post('/agentmetra/webhook', function (Illuminate\Http\Request $r) {
    $raw = $r->getContent();
    parse_str(str_replace(',', '&', $r->header('X-AgentMetra-Signature')), $sig);
    $ok = abs(time() - (int) ($sig['t'] ?? 0)) < 300
       && hash_equals(hash_hmac('sha256', $sig['t'].'.'.$raw, env('AGENTMETRA_WEBHOOK_SECRET')), $sig['v1'] ?? '');
    if (! $ok) abort(401);

    $event = json_decode($raw, true);
    $order = $event['data'];
    if ($event['event'] === 'order.created') {
        // create the sale in your system, keep $order['order_no'] and $order['id']
    }
    return response()->json(['ok' => true]);
});
```

### PHP – send stock and status

```php
$api = Http::withToken(env('AGENTMETRA_API_KEY'))->baseUrl('https://<api-host>/v1/api/open');

// every 5 minutes: stock of everything that changed
$api->post('/stock', ['items' => $changed->map(fn ($p) => ['sku' => $p->code, 'quantity' => $p->qty])->values()]);

// the order left the shop
$api->patch("/orders/number/{$sale->agentmetra_order_no}/status", ['status' => 'Shipped']);
```

### Node.js – receive orders and send stock

```js
import crypto from "node:crypto";
import express from "express";

const app = express();
app.post("/agentmetra/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  const sig = Object.fromEntries(String(req.get("X-AgentMetra-Signature")).split(",").map((p) => p.split("=")));
  const good = crypto.createHmac("sha256", process.env.AGENTMETRA_WEBHOOK_SECRET).update(`${sig.t}.${raw}`).digest("hex");
  if (Math.abs(Date.now() / 1000 - Number(sig.t)) > 300 || good !== sig.v1) return res.sendStatus(401);
  const { event, data } = JSON.parse(raw);
  if (event === "order.created") { /* save data in your system */ }
  res.json({ ok: true });
});

await fetch("https://<api-host>/v1/api/open/stock", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.AGENTMETRA_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ items: [{ sku: "94273449", quantity: 25 }] }),
});
```

### curl

```
curl -X PUT https://<api-host>/v1/api/open/products/94273449/stock \
  -H "Authorization: Bearer am_live_xxx" -H "Content-Type: application/json" -d '{"quantity": 12}'

curl -X PATCH https://<api-host>/v1/api/open/orders/number/12/status \
  -H "Authorization: Bearer am_live_xxx" -H "Content-Type: application/json" -d '{"status": "Shipped"}'
```

## A simple plan for most shops

| What | How |
|---|---|
| New products and price changes | `POST /products` when they change in your system (or once a night for all) |
| Stock | `POST /stock` every 5–15 minutes with the counts that changed, and once a night with all counts |
| New orders | Webhook `order.created`. If your server was down, `GET /orders?since=` catches up. |
| Shipped / delivered / cancelled | `PATCH /orders/number/{order_no}/status` |

## Questions

**Do I have to send every field every time?** No. On an update, send `sku` and the fields that changed.

**What happens when a product reaches 0 in my system?** Send `quantity: 0`. The product becomes Unavailable and the bot stops offering it. Send the new count when stock comes in and it becomes Available again.

**An order came from the AI bot while my system shows the item as sold out.** Send stock more often, or send the count right after each sale in your shop. The bot only sells what is available at that moment.

**Can I see what the API changed?** Stock changes appear on the **Stock count** page (open it from the stock alert or the product report) with the note "Shop API". Order changes appear in the order's history.

**I lost my key.** Create a new key and remove the old one in **Settings → Shop API & webhook**. A removed key stops working at once.
