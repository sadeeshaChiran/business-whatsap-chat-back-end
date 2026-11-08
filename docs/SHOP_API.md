# Agent Metra – Shop API (for the shop's developer)

Your own system (POS, website, ERP) keeps Agent Metra up to date by itself, and gets every order and booking the AI bot
or the team takes.

* **Base URL:** `https://<api-host>/v1/api/open` (shown in Settings → Shop API & webhook)
* **Key:** Settings → Shop API & webhook → *Create key* (shown once). Send it on every call:
  `Authorization: Bearer am_live_…` (or `X-API-Key: am_live_…`)
* JSON in, JSON out. Up to 120 calls a minute. The API acts as the business owner, so the same rules as the dashboard apply.

## Products

### Add or update – `POST /products`
Up to 500 products a call. A product with the same **sku** (or the same name) is **updated**, otherwise **added**.
On an update, fields you leave out keep their value – so a price or availability change needs only `sku` + that field.

```json
{ "products": [
  { "sku": "94272848", "name": "04 Jeep Toy", "brand": "", "category": "Toys & Games", "price": 425,
    "description": "Sinhala: ජීප් සෙල්ලම් බඩුව", "weight": 0.3, "available": true, "show_to_bot": true,
    "selling_points": "Fun gift; Save Rs 75 (regular price Rs 500)",
    "image_urls": ["https://www.chu.lk/images/product/202608111131361.png"] },
  { "sku": "94272654", "price": 1695 },
  { "sku": "SHOE-01", "name": "Baby Shoes", "category": "Shoes", "price": 1800,
    "variants": [ { "name": "Size", "value": "0-6 months", "sku": "SHOE-01-S" },
                  { "name": "Size", "value": "6-12 months", "price": 1950, "sku": "SHOE-01-M", "available": false } ] }
]}
```
Answer: `{ "created": 1, "updated": 2, "errors": 0, "results": [ { "sku": "94272848", "id": 812, "action": "updated" }, … ] }`
One bad product never stops the others – check `results[].error`.

### Available / not available – `PATCH /products/{sku}/availability`
`{ "available": false }` – a variant SKU switches only that option; or send `"variant_value": "6-12 months"`.
The AI bot never offers a product or option that is not available.

### Remove – `DELETE /products/{sku}`

## Orders
* `GET /orders?status=Pending&since=2026-11-06T00:00:00Z&limit=50` – newest first (`since` = changed after)
* `GET /orders/{id}`
* `PATCH /orders/{id}/status` `{ "status": "Shipped" }` – Pending, Confirmed, Processing, Shipped, Delivered, Cancelled.
  Same as the dashboard: the status history is kept, stock is updated and **the customer gets the status message on WhatsApp**.

Order:
```json
{ "id": 301, "status": "Pending", "channel": "whatsapp", "created_by": "bot",
  "customer": { "name": "Nimal Perera", "phone": "94771234567", "address": "10 Temple Road, Kalutara", "area": "Kalutara" },
  "payment_method": "COD", "delivery_fee": 350, "total": 2470, "weight_kg": 1.1, "note": null, "invoice_url": "https://…",
  "items": [ { "product_id": 812, "sku": "94272848", "name": "Doll oven set", "variant": null, "quantity": 1, "unit_price": 395, "total_price": 395 } ],
  "created_at": "2026-11-06T09:12:00Z", "updated_at": "2026-11-06T09:12:00Z" }
```

## Bookings
* `GET /bookings?status=requested&since=…`
* `PATCH /bookings/{id}/status` `{ "status": "confirmed" }` – requested, confirmed, done, cancelled (a time that is already
  taken is refused with 409, like in the dashboard).

## Webhook (we call you)
Settings → Shop API & webhook → your URL → *Save & switch on*. Events: `order.created`, `order.status_changed`,
`booking.created`, `booking.status_changed` (and `ping` from *Send a test*). Only orders / bookings made after you switch it
on are sent; a status you set through the API is not sent back to you.

```
POST https://your-system/agentmetra/webhook
X-AgentMetra-Event: order.created
X-AgentMetra-Signature: t=1762420320,v1=5f2c…
{ "id": "evt_…", "event": "order.created", "created_at": "…", "data": { …order…, "previous_status": "Pending" } }
```
* Answer **2xx** within 10 seconds. Otherwise we try again after 1, 2, 4, 8 … 60 minutes (12 times), in order.
* Check the signature: `v1 = hex( HMAC_SHA256( secret, t + "." + raw_body ) )` and that `t` is recent (5 minutes).
* Use `data.id` to skip a duplicate.

PHP (Laravel):
```php
Route::post('/agentmetra/webhook', function (Illuminate\Http\Request $r) {
    $raw = $r->getContent();
    parse_str(str_replace(',', '&', $r->header('X-AgentMetra-Signature')), $sig);
    $ok = abs(time() - (int) $sig['t']) < 300
       && hash_equals(hash_hmac('sha256', $sig['t'].'.'.$raw, env('AGENTMETRA_WEBHOOK_SECRET')), $sig['v1'] ?? '');
    if (! $ok) abort(401);
    $event = json_decode($raw, true);
    if ($event['event'] === 'order.created') { /* create the sale in the POS from $event['data'] */ }
    return response()->json(['ok' => true]);
});
```

Push a price / stock change (PHP):
```php
Http::withToken(env('AGENTMETRA_API_KEY'))
    ->post('https://<api-host>/v1/api/open/products', ['products' => [['sku' => $p->code, 'price' => $p->price, 'available' => $p->qty > 0]]]);
```
