#!/usr/bin/env python3
"""Makes test-shops.sql: 4 TEST companies with realistic Sri Lankan catalogs for the sales bot scale test.

  small         15 products   Little Steps Baby Shop      (baby items)
  medium       200 products   Lanka Fashion Hub           (clothes, sizes + colours)
  medium-large 750 products   Gadget Lanka                (phones accessories, electronics)
  large       2000 products   SuperMart Online            (grocery + household)

Run:  python3 scripts/make-test-shops.py > test-shops.sql   (then run the SQL in Supabase → SQL editor)
Logins: scale-small@agentmetra.test … scale-large@agentmetra.test, password printed at the top of the SQL.
Running the SQL again first deletes these 4 test companies (and their data), then makes them fresh.
"""
import hashlib
import json
import os
import random
import sys

PASSWORD = os.environ.get("TEST_SHOP_PASSWORD", "ScaleTest-2026!")
rnd = random.Random(2026)


def scrypt_hash(password: str) -> str:
    """Same format as the API: <salt hex>:<scrypt(N=16384,r=8,p=1,64) hex>."""
    salt = os.urandom(16).hex()
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return f"{salt}:{key.hex()}"


def q(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def price(lo: int, hi: int, step: int = 10) -> int:
    return rnd.randrange(lo // step, hi // step + 1) * step - (10 if rnd.random() < 0.4 else 0)


# ───────────────────────── catalogs ─────────────────────────
# (category, [(type, lo, hi, kg, variant scheme)], brands, extras)
SIZES_CLOTH = ["S", "M", "L", "XL"]
SIZES_KIDS = ["2-3Y", "4-5Y", "6-7Y", "8-9Y"]
COLOURS = ["Black", "White", "Navy", "Maroon", "Beige", "Green", "Pink", "Blue"]


def small_shop():
    rows = [
        ("Diapers", "Diapers Pack (40 pcs)", 2450, 1.2, ("Size", [("Newborn (up to 5 kg)", 2450), ("Size S (4-8 kg)", 2450), ("Size M (6-11 kg)", 2650), ("Size L (9-14 kg)", 2850)]),
         "Soft, leak-proof diapers for day and night.", "No leaks at night. Soft on baby's skin. Imported."),
        ("Baby care", "Baby Wipes (80 pcs)", 390, 0.4, None, "Alcohol-free wet wipes with aloe.", "Alcohol free. Thick and soft."),
        ("Baby care", "Baby Lotion 200ml", 890, 0.25, None, "Mild lotion for newborn skin.", "Dermatologist tested."),
        ("Baby care", "Baby Soap", 290, 0.1, None, "Gentle baby soap with milk protein.", "Tear-free, mild."),
        ("Baby care", "Baby Shampoo 200ml", 750, 0.25, None, "No-tears baby shampoo.", "No tears formula."),
        ("Clothes", "Cotton Romper Set (3 pcs)", 2200, 0.4, ("Age", [("0-3 months", 2200), ("3-6 months", 2200), ("6-12 months", 2300)]),
         "Pure cotton rompers, pack of 3 colours.", "100% cotton, breathable, easy snap buttons."),
        ("Clothes", "Baby Blanket", 1850, 0.6, None, "Soft fleece baby blanket 90x75 cm.", "Warm and light."),
        ("Clothes", "Mittens and Socks Set", 650, 0.1, None, "3 pairs mittens + 3 pairs socks.", "Keeps tiny hands warm."),
        ("Shoes", "Baby Shoes", 1450, 0.2, ("Size", [("Size 1 (0-6 months)", 1450), ("Size 2 (6-12 months)", 1450), ("Size 3 (12-18 months)", 1550)]),
         "Soft sole first walking shoes.", "Non-slip soft sole."),
        ("Feeding", "Feeding Bottle", 1450, 0.2, ("Size", [("150 ml", 1450), ("250 ml", 1650)]), "BPA-free anti-colic bottle.", "Anti-colic valve, BPA free."),
        ("Feeding", "Baby Food Maker", 6900, 1.5, None, "Steam and blend baby food in one.", "Steams and blends in 15 minutes."),
        ("Gifts", "Newborn Gift Pack", 4900, 1.0, None, "Hat, socks, mittens, towel, bib and rattle in a gift box.", "Ready gift box. Best seller for baby visits."),
        ("Toys", "Teething Toy", 690, 0.1, None, "Soft silicone teether.", "Food-grade silicone."),
        ("Toys", "Soft Stacking Blocks", 1990, 0.5, None, "6 soft blocks with numbers and animals.", "Safe soft blocks for 6 months+."),
        ("Toys", "Musical Rattle Set", 1250, 0.3, None, "Set of 4 colourful rattles.", "Bright colours, gentle sounds."),
    ]
    out = []
    for cat, name, p, kg, var, desc, sp in rows:
        out.append({"cat": cat, "name": name, "price": p, "kg": kg, "desc": desc, "sp": sp,
                    "variants": [{"variant_name": var[0], "variant_value": v, "price": vp} for v, vp in var[1]] if var else []})
    return out


def generated(spec, target):
    """spec: list of (category, types[(name, lo, hi, kg, variants)], brands, adjectives). Unique names until target."""
    out, seen = [], set()
    while len(out) < target:
        cat, types, brands, adjectives = rnd.choice(spec)
        tname, lo, hi, kg, scheme = rnd.choice(types)
        name = f"{rnd.choice(brands)} {rnd.choice(adjectives)} {tname}".replace("  ", " ").strip()
        if name in seen:
            name = f"{name} {rnd.choice(['Pro', 'Plus', 'Max', 'Lite', 'Classic', 'Mini', 'XL', 'Twin Pack', 'Value Pack'])}"
            if name in seen:
                continue
        seen.add(name)
        p = price(lo, hi)
        variants = []
        if scheme == "cloth":
            colours = rnd.sample(COLOURS, 2)
            variants = [{"variant_name": "Size / Colour", "variant_value": f"{s} / {c}", "price": p + (100 if s == "XL" else 0)} for c in colours for s in SIZES_CLOTH]
        elif scheme == "kids":
            variants = [{"variant_name": "Age", "variant_value": s, "price": p} for s in SIZES_KIDS]
        elif scheme == "colour":
            variants = [{"variant_name": "Colour", "variant_value": c, "price": p} for c in rnd.sample(COLOURS, 3)]
        elif scheme == "size_pack":
            variants = [{"variant_name": "Pack", "variant_value": s, "price": round(p * m / 10) * 10} for s, m in (("Small", 1), ("Medium", 1.8), ("Large", 3.2))]
        elif scheme == "phone":
            variants = [{"variant_name": "Model", "variant_value": m, "price": p} for m in rnd.sample(
                ["iPhone 15", "iPhone 14", "iPhone 13", "Samsung A55", "Samsung A35", "Samsung S24", "Redmi Note 13", "Galaxy A15"], 4)]
        desc = f"{name}. {rnd.choice(['Original product with warranty.', 'Best seller.', 'Good quality at a fair price.', 'Imported.', 'Made in Sri Lanka.'])}"
        out.append({"cat": cat, "name": name, "price": p, "kg": kg, "desc": desc, "sp": rnd.choice(
            ["Cash on delivery island-wide.", "7-day exchange.", "Top rated by customers.", "Fast delivery.", ""]), "variants": variants})
    return out


FASHION = [
    ("Women Dresses", [("Maxi Dress", 2990, 6990, 0.4, "cloth"), ("Office Frock", 2490, 5490, 0.35, "cloth"), ("Party Dress", 3990, 9990, 0.45, "cloth")],
     ["Kandyan", "Ruhunu", "Ceylon", "Lotus", "Serendib"], ["Floral", "Linen", "Batik", "Chiffon", "Cotton"]),
    ("Sarees", [("Saree", 3490, 18990, 0.7, "colour"), ("Osariya Saree", 4990, 15990, 0.8, "colour")],
     ["Kandyan", "Lotus", "Dhara", "Serendib"], ["Silk", "Batik", "Handloom", "Georgette", "Cotton"]),
    ("Men Shirts", [("Shirt", 1990, 4990, 0.3, "cloth"), ("Polo T-Shirt", 1490, 3490, 0.25, "cloth")],
     ["Ceylon", "Urban", "Royal", "Colombo"], ["Slim Fit", "Linen", "Oxford", "Check", "Cotton"]),
    ("Men Trousers", [("Trouser", 2490, 5990, 0.5, "cloth"), ("Denim Jeans", 2990, 6990, 0.6, "cloth")],
     ["Urban", "Royal", "Colombo"], ["Slim Fit", "Chino", "Stretch", "Classic"]),
    ("Kids Wear", [("Kids Frock", 1490, 3490, 0.2, "kids"), ("Boys T-Shirt", 990, 1990, 0.15, "kids"), ("Kids Shorts", 890, 1790, 0.15, "kids")],
     ["Little Lanka", "Tiny Tots", "Kiddo"], ["Cartoon", "Cotton", "Summer", "Party"]),
    ("Bags & Accessories", [("Handbag", 2490, 8990, 0.6, "colour"), ("Wallet", 990, 3490, 0.15, "colour"), ("Belt", 890, 2490, 0.2, None)],
     ["Royal", "Urban", "Lotus"], ["Leather", "Classic", "Office", "Travel"]),
]

GADGETS = [
    ("Phone Covers", [("Back Cover", 690, 1990, 0.05, "phone"), ("Flip Cover", 990, 2490, 0.08, "phone")],
     ["Spigen", "Ringke", "Nillkin", "UAG", "Baseus"], ["Clear", "Rugged", "Silicone", "Leather", "MagSafe"]),
    ("Chargers & Cables", [("Fast Charger", 1490, 6990, 0.12, None), ("USB-C Cable", 490, 2490, 0.06, None), ("Car Charger", 990, 3490, 0.08, None)],
     ["Anker", "Baseus", "Ugreen", "Samsung", "Apple"], ["20W", "25W", "45W", "65W", "Braided"]),
    ("Earbuds & Headphones", [("Wireless Earbuds", 2990, 39990, 0.15, "colour"), ("Headphones", 3990, 49990, 0.35, "colour"), ("Neckband", 1990, 6990, 0.1, None)],
     ["JBL", "Sony", "Soundcore", "Realme", "Samsung"], ["Bass", "ANC", "Sport", "Pro", "Lite"]),
    ("Power Banks", [("Power Bank", 2990, 14990, 0.35, None)], ["Anker", "Baseus", "Xiaomi", "Remax"], ["10000mAh", "20000mAh", "Slim", "MagSafe"]),
    ("Smart Watches", [("Smart Watch", 4990, 89990, 0.1, "colour"), ("Fitness Band", 2990, 14990, 0.05, "colour")],
     ["Xiaomi", "Huawei", "Amazfit", "Samsung", "Apple"], ["Sport", "Active", "Pro", "Lite"]),
    ("Screen Protectors", [("Tempered Glass", 490, 1990, 0.03, "phone"), ("Privacy Glass", 990, 2490, 0.03, "phone")],
     ["Nillkin", "Spigen", "Remax"], ["9H", "Full Glue", "Matte", "Clear"]),
    ("Computer Accessories", [("Wireless Mouse", 990, 7990, 0.1, None), ("Keyboard", 1990, 14990, 0.6, None), ("USB Flash Drive", 990, 4990, 0.02, None), ("Laptop Bag", 2990, 9990, 0.7, None)],
     ["Logitech", "HP", "SanDisk", "Kingston", "Dell"], ["Silent", "Gaming", "Office", "Mini", "Pro"]),
    ("Speakers", [("Bluetooth Speaker", 2990, 59990, 0.6, "colour"), ("Soundbar", 14990, 89990, 3.0, None)],
     ["JBL", "Sony", "Anker", "Xiaomi"], ["Portable", "Waterproof", "Party", "Mini"]),
]

GROCERY = [
    ("Rice & Grains", [("Samba Rice 5kg", 1290, 1890, 5.0, None), ("Red Rice 5kg", 1190, 1690, 5.0, None), ("Basmati Rice 1kg", 690, 1290, 1.0, None), ("Dhal 1kg", 390, 590, 1.0, None)],
     ["Araliya", "Nipuna", "Keeri", "Harischandra", "Ma's"], ["Premium", "Organic", "Value", "Classic", "Kekulu"]),
    ("Milk Powder & Dairy", [("Milk Powder 400g", 1190, 1490, 0.45, None), ("Milk Powder 1kg", 2690, 3390, 1.05, None), ("Yoghurt", 90, 160, 0.1, None), ("Cheese", 690, 1790, 0.25, None)],
     ["Anchor", "Highland", "Ratthi", "Kotmale", "Pelwatte"], ["Full Cream", "Low Fat", "Kids", "Fresh"]),
    ("Tea & Coffee", [("Tea 400g", 690, 1490, 0.42, None), ("Tea Bags (100)", 590, 1290, 0.22, None), ("Instant Coffee 100g", 790, 1990, 0.12, None)],
     ["Dilmah", "Lipton", "Watawala", "Zesta", "Nescafe"], ["Ceylon", "Premium", "Green", "Gold", "Classic"]),
    ("Spices", [("Chilli Powder 250g", 290, 690, 0.25, None), ("Curry Powder 250g", 290, 690, 0.25, None), ("Pepper 100g", 290, 590, 0.1, None), ("Turmeric 100g", 150, 390, 0.1, None)],
     ["MA's", "Larich", "Motha", "Harischandra"], ["Roasted", "Pure", "Organic", "Classic"]),
    ("Snacks & Biscuits", [("Biscuits", 120, 690, 0.2, None), ("Cream Crackers", 190, 590, 0.4, None), ("Chips", 150, 590, 0.1, None)],
     ["Munchee", "Maliban", "Ritzbury", "Tiara", "Uswatte"], ["Chocolate", "Cream", "Lemon", "Spicy", "Classic"]),
    ("Beverages", [("Fizzy Drink 1.5L", 290, 490, 1.6, None), ("Fruit Juice 1L", 390, 890, 1.05, None), ("Water 1.5L", 100, 160, 1.5, None)],
     ["Elephant House", "Coca-Cola", "Kist", "Smak", "Sprite"], ["Orange", "Mango", "Lime", "Classic", "Zero"]),
    ("Household & Cleaning", [("Dishwash Liquid 500ml", 290, 690, 0.55, None), ("Washing Powder 1kg", 490, 1190, 1.0, None), ("Floor Cleaner 1L", 490, 990, 1.05, None), ("Toilet Cleaner 500ml", 390, 790, 0.55, None)],
     ["Sunlight", "Vim", "Harpic", "Surf Excel", "Rinso"], ["Lemon", "Lavender", "Power", "Fresh", "Classic"]),
    ("Personal Care", [("Shampoo 180ml", 390, 1290, 0.2, None), ("Soap (4 pack)", 390, 890, 0.4, None), ("Toothpaste 120g", 190, 590, 0.15, None), ("Body Lotion 400ml", 690, 1990, 0.42, None)],
     ["Sunsilk", "Lux", "Signal", "Clogard", "Vaseline", "Baby Cheramy"], ["Herbal", "Fresh", "Whitening", "Moisture", "Classic"]),
    ("Baby & Kids", [("Baby Diapers", 1490, 4490, 1.2, "size_pack"), ("Baby Food", 390, 1290, 0.3, None)],
     ["Pampers", "Velona", "Huggies", "Cerelac"], ["Soft", "Premium", "Value", "Classic"]),
    ("Frozen & Meat", [("Chicken Sausages 500g", 590, 1290, 0.5, None), ("Fish Fingers 400g", 690, 1490, 0.4, None), ("Ice Cream 1L", 590, 1490, 1.0, None)],
     ["Keells", "Bairaha", "Crysbro", "Elephant House", "Cargills"], ["Classic", "Spicy", "Premium", "Family Pack"]),
]

SHOPS = [
    {"key": "small", "name": "Little Steps Baby Shop", "email": "scale-small@agentmetra.test", "products": small_shop,
     "about": "Imported baby items for 0-3 years: diapers, clothes, feeding, toys and gift packs. Island-wide delivery, cash on delivery.",
     "greeting": "", "hours": "8am - 8pm every day", "pay": "Cash on delivery, bank transfer"},
    {"key": "medium", "name": "Lanka Fashion Hub", "email": "scale-medium@agentmetra.test", "products": lambda: generated(FASHION, 200),
     "about": "Clothes for women, men and kids: dresses, sarees, shirts, trousers, bags. Sizes S-XL. Island-wide delivery, COD.",
     "greeting": "", "hours": "9am - 9pm every day", "pay": "Cash on delivery, bank transfer, card on delivery in Colombo"},
    {"key": "mediumlarge", "name": "Gadget Lanka", "email": "scale-mediumlarge@agentmetra.test", "products": lambda: generated(GADGETS, 750),
     "about": "Phone accessories and electronics: covers, chargers, earbuds, power banks, smart watches, speakers. Original items with warranty.",
     "greeting": "", "hours": "9am - 7pm Mon-Sat", "pay": "Cash on delivery, bank transfer, KOKO"},
    {"key": "large", "name": "SuperMart Online", "email": "scale-large@agentmetra.test", "products": lambda: generated(GROCERY, 2000),
     "about": "Online supermarket: rice, milk powder, tea, spices, snacks, drinks, cleaning and personal care. Same day delivery in Colombo.",
     "greeting": "", "hours": "7am - 10pm every day", "pay": "Cash on delivery, card, bank transfer"},
]

POLICIES = [
    ("Delivery", "Colombo 1-2 days, other areas 2-4 days. Free delivery for orders over Rs 15,000."),
    ("Payment", "Cash on delivery island-wide. Bank transfer also accepted."),
    ("Returns", "Exchange within 7 days if unused, with the bill. No cash refunds."),
    ("Original", "All items are 100% original."),
]
FAQS = [
    ("Do you have a shop to visit?", "We are online only. You can order here on WhatsApp."),
    ("Can I get it today?", "Same day delivery only inside Colombo for orders before 12 noon."),
    ("Do you deliver to Jaffna?", "Yes, island-wide delivery, 3-4 days to Jaffna."),
    ("Is there a warranty?", "Electronics have the brand warranty. Other items have 7-day exchange."),
    ("Can I change my order?", "Yes, before it is shipped. Just tell us here."),
    ("Do you give bulk discounts?", "For bulk orders our team will give a special price."),
    ("Can I pay by card?", "Card on delivery is available in Colombo only."),
    ("How do I track my order?", "Ask here with your name and we will tell you the status."),
]
STYLES = [
    ("price kiyada", "Rs 2,450 yi 😊 Colombo ta delivery Rs 350, dawas 1-2. Ganna kamathi nam nama saha address eka ewanna."),
    ("too expensive", "I understand. This one is original with warranty, and we have a cheaper option too. Shall I send it?"),
    ("COD thiyenawada", "Ow, cash on delivery puluwan. Nama, address saha phone number eka ewwoth order eka dannam."),
]


def main():
    global SHOPS
    only = sys.argv[sys.argv.index("--shop") + 1].split(",") if "--shop" in sys.argv else None
    if only:  # one file per shop (smaller files for the Supabase SQL editor)
        SHOPS = [s for s in SHOPS if s["key"] in only]
    pw = scrypt_hash(PASSWORD)
    emails = ", ".join(q(s["email"]) for s in SHOPS)
    logins = "\n".join(f"--   {s['email']}  {s['name']}" for s in SHOPS)
    print(f"""-- Agent Metra – 4 TEST shops for the sales bot scale test (generated by scripts/make-test-shops.py)
-- Logins (password for all: {PASSWORD}):
{logins}
-- Run in Supabase → SQL editor. Running it again deletes these 4 test companies first.
-- Delete them later with the DELETE block at the top (only these 4 e-mails are touched).
BEGIN;

-- 0) remove an older copy of these 4 test companies
CREATE TEMP TABLE _old ON COMMIT DROP AS SELECT company_id AS id FROM app_user WHERE email IN ({emails}) AND company_id IS NOT NULL;
DELETE FROM bot_ai_usage WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_order_item WHERE order_id IN (SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_order_status_history WHERE order_id IN (SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_order WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_message WHERE conversation_id IN (SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id IN (SELECT id FROM _old));
DELETE FROM bot_conversation WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_customer_note WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_notification WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_channel_user WHERE company_id IN (SELECT id FROM _old);
DELETE FROM product_variant WHERE product_id IN (SELECT id FROM product WHERE company_id IN (SELECT id FROM _old));
DELETE FROM product WHERE company_id IN (SELECT id FROM _old);
DELETE FROM product_catergory WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_delivery_zone WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_training_data WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_sales_settings WHERE company_id IN (SELECT id FROM _old);
DELETE FROM company_subscription WHERE company_id IN (SELECT id FROM _old);
UPDATE companies SET admin_user_id = NULL WHERE id IN (SELECT id FROM _old);
DELETE FROM app_user WHERE email IN ({emails});
DELETE FROM companies WHERE id IN (SELECT id FROM _old);
""")
    for shop in SHOPS:
        products = shop["products"]()
        key = shop["key"]
        cats = sorted({p["cat"] for p in products})
        print(f"\n-- ───────── {shop['name']} ({len(products)} products) ─────────")
        print(f"""DO $$
DECLARE
  cid BIGINT; uid INT; pkg INT; pcode TEXT; cat_ids JSONB := '{{}}'::jsonb; cat_id INT; pid INT;
BEGIN
  SELECT id, code INTO pkg, pcode FROM platform_package WHERE code IN ('pro', 'business', 'scale') AND is_active ORDER BY tokens_per_month DESC LIMIT 1;
  IF pkg IS NULL THEN SELECT id, code INTO pkg, pcode FROM platform_package ORDER BY tokens_per_month DESC LIMIT 1; END IF;
  INSERT INTO companies (company_name, status, plan, email, phone, address, business_category, bot_enabled)
    VALUES ({q(shop['name'] + ' (TEST)')}, 'ACTIVE', pcode, {q(shop['email'])}, '0770000000', 'Colombo', 'product', TRUE) RETURNING id INTO cid;
  INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, whatsapp_number, whatsapp_verified_at)
    VALUES ({q(shop['name'] + ' Owner')}, {q(shop['email'])}, {q(pw)}, TRUE, cid, NOW(), '9477000000{SHOPS.index(shop)}', NOW()) RETURNING id INTO uid;
  UPDATE companies SET admin_user_id = uid WHERE id = cid;
  INSERT INTO company_subscription (company_id, package_id, billing_cycle, status, period_start, period_end, token_period_start, token_period_end, auto_renew)
    VALUES (cid, pkg, 'monthly', 'active', NOW(), NOW() + INTERVAL '30 days', NOW(), NOW() + INTERVAL '30 days', FALSE);
  INSERT INTO bot_sales_settings (company_id, tone, default_language, about, opening_hours, payment_methods, auto_enable_new_customers, sells, free_delivery_over)
    VALUES (cid, 'friendly, short, helpful', 'auto', {q(shop['about'])}, {q(shop['hours'])}, {q(shop['pay'])}, TRUE, 'products', 15000);
  INSERT INTO bot_delivery_zone (company_id, area, fee, days, included_kg, per_extra_kg) VALUES
    (cid, 'Colombo', 350, '1-2 days', 2, 60), (cid, 'Gampaha', 400, '2-3 days', 2, 70), (cid, 'Kandy', 450, '2-3 days', 2, 80), (cid, '*', 450, '2-4 days', 2, 80);""")
        for c in cats:
            print(f"  INSERT INTO product_catergory (name, company_id, is_active) VALUES ({q(c)}, cid, TRUE) RETURNING id INTO cat_id; cat_ids := cat_ids || jsonb_build_object({q(c)}, cat_id);")
        for i, p in enumerate(products):
            sku = f"{key[:3].upper()}-{i + 1:04d}"
            available = rnd.random() > 0.04
            print(f"  INSERT INTO product (name, description, sku, price, quantity, status, category_id, company_id, created_by, has_variants, weight, selling_points, is_available, show_to_bot) "
                  f"VALUES ({q(p['name'])}, {q(p['desc'])}, {q(sku)}, {p['price']}, {0 if not available else rnd.randint(3, 60)}, {q('In Stock' if available else 'Out of Stock')}, "
                  f"(cat_ids->>{q(p['cat'])})::int, cid, uid, {q(bool(p['variants']))}, {p['kg']}, {q(p['sp'])}, {q(available)}, TRUE) RETURNING id INTO pid;")
            if p["variants"]:
                vs = [{**v, "sku": f"{sku}-{j + 1}", "quantity": rnd.randint(0, 20), "weight": p["kg"]} for j, v in enumerate(p["variants"])]
                print(f"  INSERT INTO product_variant (product_id, variants) VALUES (pid, {q(json.dumps(vs, ensure_ascii=False))}::jsonb);")
        for cat, (qq, a) in [("policy", x) for x in POLICIES] + [("faq", x) for x in FAQS] + [("style", x) for x in STYLES]:
            print(f"  INSERT INTO bot_training_data (company_id, category, question, answer, language, is_active) VALUES (cid, {q(cat)}, {q(qq)}, {q(a)}, 'auto', TRUE);")
        print("END $$;")
    print("\nCOMMIT;")
    print(f"\n-- check: SELECT c.company_name, COUNT(p.id) FROM companies c LEFT JOIN product p ON p.company_id = c.id WHERE c.email IN ({emails}) GROUP BY 1 ORDER BY 2;")
    print("# made", file=sys.stderr)


if __name__ == "__main__":
    main()
