#!/usr/bin/env python3
"""Makes vora-demo.sql: fills the existing VORA account (clothing shop demo) with a full, realistic setup.

  - 72 products in 12 categories: simple products, size variants with the SAME price, size variants with
    DIFFERENT prices (XXL / big waist / older kids cost more), colour + size combinations, a few sold-out options
  - delivery by LOCATION only (no weight charges), free delivery over Rs 10,000
  - bot settings (about, hours, payment, greeting) and shop knowledge (size guide, exchange, COD ...)

Only the company named VORA is touched. Running again replaces VORA's products (SKU VORA-...), delivery zones and knowledge.
Run:  python3 scripts/make-vora-demo.py > vora-demo.sql
Load: psql -h localhost -p 5433 -U agentmetra -d agentmetra -v ON_ERROR_STOP=1 -f vora-demo.sql
"""
import json
import random

rnd = random.Random(15)
COMPANY = "VORA"


def q(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


W = ["S", "M", "L", "XL"]
W2 = ["S", "M", "L", "XL", "XXL"]
M = ["M", "L", "XL", "XXL"]
WAIST_W = ["26", "28", "30", "32", "34"]
WAIST_M = ["30", "32", "34", "36", "38"]
KIDS = ["2-3Y", "4-5Y", "6-7Y", "8-9Y", "10-11Y"]


def same(name, values, price):
    """size options, all the same price"""
    return [(name, v, price) for v in values]


def bigger(name, values, price, extra, from_value):
    """bigger sizes cost more (from_value and up)"""
    start = values.index(from_value)
    return [(name, v, price + (extra if i >= start else 0)) for i, v in enumerate(values)]


def colour_size(colours, sizes, price, extra_big=0):
    return [("Colour / Size", f"{c} / {s}", price + (extra_big if s in ("XXL", "38") else 0)) for c in colours for s in sizes]


def kids(price, step):
    return [("Age", v, price + step * i) for i, v in enumerate(KIDS)]


# (category, name, brand, price, variants or None, description, selling points)
P = [
    # ── Women's dresses ──
    ("Women's Dresses", "Floral Wrap Midi Dress", "VORA", 4490, same("Size", W, 4490), "Soft rayon wrap dress with a tie waist and flutter sleeves. Midi length.", "Breathable rayon. Adjustable wrap waist. Office or casual."),
    ("Women's Dresses", "Linen Shirt Dress", "VORA", 5290, colour_size(["Beige", "Olive", "White"], W, 5290), "Button-down linen-blend shirt dress with pockets and a belt.", "Linen blend, cool for hot days. Side pockets."),
    ("Women's Dresses", "Tiered Maxi Dress", "VORA", 5990, same("Size", W2, 5990), "Flowy tiered maxi with smocked back. Full lining.", "Smocked back fits many body shapes. Fully lined."),
    ("Women's Dresses", "Little Black Party Dress", "VORA", 6490, same("Size", W, 6490), "Fitted knee-length party dress in stretch crepe.", "Stretch crepe. Hidden back zip."),
    ("Women's Dresses", "Batik Print Shift Dress", "VORA", 4990, same("Size", W, 4990), "Sri Lankan batik-inspired print, straight cut, sleeveless.", "Local batik design. Easy straight fit."),
    ("Women's Dresses", "Puff Sleeve Mini Dress", "VORA", 3990, colour_size(["Pink", "Lilac"], ["S", "M", "L"], 3990), "Cotton mini dress with puff sleeves and square neck.", "100% cotton. Cute day look."),
    ("Women's Dresses", "Satin Slip Dress", "VORA", 5490, same("Size", W, 5490), "Bias-cut satin slip dress with adjustable straps.", "Silky satin. Adjustable straps."),
    ("Women's Dresses", "Plus Size A-Line Dress", "VORA Curve", 5490, [("Size", "XL", 5490), ("Size", "XXL", 5790), ("Size", "3XL", 6090), ("Size", "4XL", 6390)], "A-line dress made for curvy bodies with 3/4 sleeves.", "Made for sizes XL-4XL. Flattering A-line."),
    ("Women's Dresses", "Denim Pinafore Dress", "VORA", 4790, same("Size", W, 4790), "Classic denim pinafore with front pocket. Wear over a tee.", "Soft washed denim. Adjustable straps."),
    ("Women's Dresses", "Embroidered Kaftan", "VORA", 3990, None, "Free-size cotton kaftan with neckline embroidery. Fits S to XXL.", "Free size. Hand embroidery. Beach or home."),
    # ── Tops ──
    ("Women's Tops", "Basic Cotton Tee", "VORA Essentials", 1490, colour_size(["White", "Black", "Grey", "Pink"], W, 1490), "Everyday crew-neck tee in combed cotton.", "Combed cotton. Does not shrink."),
    ("Women's Tops", "Ruffle Sleeve Blouse", "VORA", 2990, same("Size", W, 2990), "Light georgette blouse with ruffle sleeves. Office ready.", "Georgette, flowy. Office wear."),
    ("Women's Tops", "Linen Button Shirt", "VORA", 3490, colour_size(["White", "Sky Blue", "Beige"], W, 3490), "Relaxed linen-blend shirt, roll-up sleeves.", "Linen blend. Relaxed fit."),
    ("Women's Tops", "Crop Rib Top", "VORA", 1790, same("Size", ["S", "M", "L"], 1790), "Stretch rib crop top with square neck.", "Stretchy rib knit."),
    ("Women's Tops", "Peplum Office Top", "VORA", 3290, bigger("Size", W2, 3290, 300, "XXL"), "Structured peplum top with back zip.", "Smart office look. XXL available."),
    ("Women's Tops", "Off-Shoulder Top", "VORA", 2490, same("Size", W, 2490), "Elastic off-shoulder top with smocked waist.", "Smocked, comfy fit."),
    ("Women's Tops", "Oversized Graphic Tee", "VORA", 1990, same("Size", ["Free size"], 1990), "Oversized drop-shoulder tee with minimal print.", "Oversized trendy fit."),
    ("Women's Tops", "Satin Cami Top", "VORA", 2290, colour_size(["Champagne", "Black", "Emerald"], ["S", "M", "L"], 2290), "Satin camisole with adjustable straps.", "Wear alone or under a blazer."),
    # ── Ethnic ──
    ("Ethnic Wear", "Cotton Kurta Set (3 pcs)", "VORA Ethnic", 6990, same("Size", W2, 6990), "Kurta, pants and dupatta set in printed cotton.", "3-piece set. Pure cotton."),
    ("Ethnic Wear", "Georgette Party Kurta", "VORA Ethnic", 5490, bigger("Size", W2, 5490, 400, "XXL"), "Embroidered georgette kurta for functions.", "Embroidered neckline. Lined."),
    ("Ethnic Wear", "Handloom Saree", "VORA Ethnic", 8900, None, "Sri Lankan handloom cotton saree with blouse piece (unstitched).", "Locally handwoven. Blouse piece included."),
    ("Ethnic Wear", "Silk Look Party Saree", "VORA Ethnic", 12500, None, "Soft silk-look saree with zari border and blouse piece.", "Zari border. Light and easy to drape."),
    ("Ethnic Wear", "Ready-made Saree Blouse", "VORA Ethnic", 2490, bigger("Size", ["32", "34", "36", "38", "40", "42"], 2490, 250, "40"), "Stretch saree blouse, ready to wear, back hooks.", "Ready to wear. Stretch fabric."),
    ("Ethnic Wear", "Palazzo Pants", "VORA Ethnic", 2290, same("Size", ["Free size"], 2290), "Wide flowy palazzo with elastic waist.", "Elastic waist, free size."),
    # ── Women's bottoms ──
    ("Women's Bottoms", "High Waist Skinny Jeans", "VORA Denim", 4490, bigger("Waist", WAIST_W, 4490, 300, "32"), "Stretch high-waist skinny jeans, mid blue.", "Super stretch. High waist hold."),
    ("Women's Bottoms", "Wide Leg Jeans", "VORA Denim", 4990, same("Waist", WAIST_W, 4990), "Relaxed wide-leg jeans, light wash.", "Trendy wide leg. Soft denim."),
    ("Women's Bottoms", "Linen Wide Pants", "VORA", 3490, colour_size(["Beige", "Black", "White"], W, 3490), "Linen-blend wide pants with drawstring.", "Cool linen. Drawstring waist."),
    ("Women's Bottoms", "Pleated Midi Skirt", "VORA", 3290, same("Size", ["S", "M", "L"], 3290), "Flowy pleated midi skirt with elastic waist.", "Elastic waist. Office or casual."),
    ("Women's Bottoms", "Office Trousers", "VORA", 3790, bigger("Size", W2, 3790, 300, "XXL"), "Straight-cut stretch office trousers.", "Wrinkle resistant."),
    ("Women's Bottoms", "Denim Shorts", "VORA Denim", 2490, same("Waist", ["26", "28", "30", "32"], 2490), "Mid-rise frayed-hem denim shorts.", "Soft denim."),
    # ── Men's shirts ──
    ("Men's Shirts", "Oxford Cotton Shirt", "VORA Men", 3990, colour_size(["White", "Light Blue", "Pink"], M, 3990, 300), "Classic Oxford long-sleeve shirt with button-down collar.", "100% cotton Oxford. Office and casual."),
    ("Men's Shirts", "Linen Short Sleeve Shirt", "VORA Men", 3490, colour_size(["Beige", "Navy", "Olive"], M, 3490), "Breathable linen-blend short-sleeve shirt.", "Linen blend. Perfect for Sri Lankan heat."),
    ("Men's Shirts", "Slim Fit Formal Shirt", "VORA Men", 3790, bigger("Size", ["15", "15.5", "16", "16.5", "17"], 3790, 200, "17"), "Slim formal shirt, easy iron. Sizes by collar.", "Easy iron. Slim fit."),
    ("Men's Shirts", "Batik Shirt", "VORA Men", 4290, same("Size", M, 4290), "Hand-printed Sri Lankan batik short-sleeve shirt.", "Real batik. Each one is a little different."),
    ("Men's Shirts", "Denim Shirt", "VORA Men", 4490, same("Size", M, 4490), "Washed denim shirt with two chest pockets.", "Soft washed denim."),
    ("Men's Shirts", "Check Flannel Shirt", "VORA Men", 3690, same("Size", M, 3690), "Soft brushed cotton check shirt.", "Brushed cotton, soft."),
    ("Men's Shirts", "Mandarin Collar Shirt", "VORA Men", 3590, colour_size(["White", "Black"], M, 3590), "Band collar cotton shirt, smart casual.", "Modern band collar."),
    ("Men's Shirts", "Printed Resort Shirt", "VORA Men", 3290, same("Size", M, 3290), "Viscose resort shirt with tropical print.", "Holiday vibe. Flowy viscose."),
    # ── Men's T-shirts ──
    ("Men's T-Shirts", "Basic Crew Tee", "VORA Essentials", 1290, colour_size(["White", "Black", "Navy", "Grey"], M, 1290, 200), "Everyday cotton crew-neck tee.", "Combed cotton. Pre-shrunk."),
    ("Men's T-Shirts", "Polo T-Shirt", "VORA Men", 2490, colour_size(["Navy", "White", "Maroon"], M, 2490, 200), "Pique cotton polo with 3 buttons.", "Pique cotton. Smart casual."),
    ("Men's T-Shirts", "Oversized Street Tee", "VORA Men", 1990, same("Size", ["M", "L", "XL"], 1990), "Heavy cotton oversized tee with back print.", "Heavy 220 GSM cotton."),
    ("Men's T-Shirts", "Dri-Fit Sports Tee", "VORA Active", 1890, same("Size", M, 1890), "Quick-dry sports tee for gym and running.", "Quick dry. Light."),
    ("Men's T-Shirts", "V-Neck Tee", "VORA Essentials", 1390, same("Size", M, 1390), "Soft V-neck tee.", "Soft and stretchy."),
    ("Men's T-Shirts", "Henley Tee", "VORA Men", 1990, same("Size", M, 1990), "Long-sleeve henley in slub cotton.", "Slub cotton texture."),
    ("Men's T-Shirts", "Tee Pack (3 pcs)", "VORA Essentials", 3490, bigger("Size", M, 3490, 300, "XXL"), "3 basic tees: white, black, grey.", "Best value pack."),
    # ── Men's bottoms ──
    ("Men's Bottoms", "Slim Fit Jeans", "VORA Denim", 4990, bigger("Waist", WAIST_M, 4990, 400, "36"), "Stretch slim jeans, dark wash.", "Stretch denim. Slim fit."),
    ("Men's Bottoms", "Regular Fit Jeans", "VORA Denim", 4790, bigger("Waist", WAIST_M, 4790, 400, "36"), "Comfort regular-fit jeans, mid blue.", "Classic comfy fit."),
    ("Men's Bottoms", "Chino Pants", "VORA Men", 3990, colour_size(["Khaki", "Navy", "Black"], WAIST_M, 3990, 300), "Stretch cotton chinos, slim-straight.", "Stretch cotton. Office or casual."),
    ("Men's Bottoms", "Formal Trousers", "VORA Men", 4290, same("Waist", WAIST_M, 4290), "Flat-front formal trousers, wrinkle resistant.", "Wrinkle resistant."),
    ("Men's Bottoms", "Cargo Shorts", "VORA Men", 2690, same("Waist", WAIST_M, 2690), "Cotton cargo shorts with 6 pockets.", "Lots of pockets."),
    ("Men's Bottoms", "Jogger Pants", "VORA Active", 2990, same("Size", M, 2990), "Cotton fleece joggers with cuffed ankle.", "Soft fleece. Zip pockets."),
    # ── Sarongs ──
    ("Sarongs", "Cotton Sarong", "VORA Men", 1490, None, "Classic checked cotton sarong, ready stitched. Free size.", "Pure cotton. Ready stitched."),
    ("Sarongs", "Batik Sarong", "VORA Men", 2490, None, "Hand-made batik sarong, ready stitched.", "Real batik, made in Sri Lanka."),
    ("Sarongs", "Premium Sarong (2 pack)", "VORA Men", 2690, None, "Two premium cotton sarongs in assorted colours.", "Value pack of 2."),
    # ── Kids ──
    ("Kids", "Girls Frock", "VORA Kids", 2490, kids(2490, 200), "Cotton party frock with bow. Older ages cost a little more.", "Soft cotton lining."),
    ("Kids", "Boys Shirt & Shorts Set", "VORA Kids", 2790, kids(2790, 200), "Printed shirt with matching shorts.", "2-piece set."),
    ("Kids", "Kids Basic Tee", "VORA Kids", 890, same("Age", KIDS, 890), "Cotton tee for kids, same price for all ages.", "Soft cotton."),
    ("Kids", "Kids Denim Jeans", "VORA Kids", 2290, kids(2290, 150), "Elastic-waist kids jeans.", "Elastic waist, easy to wear."),
    ("Kids", "School Socks (5 pairs)", "VORA Kids", 990, None, "White school socks, pack of 5.", "Pack of 5."),
    # ── Nightwear ──
    ("Nightwear", "Cotton Pyjama Set", "VORA", 2990, same("Size", W2, 2990), "Women's cotton pyjama shirt and pants.", "Soft cotton for sleeping."),
    ("Nightwear", "Satin Night Set", "VORA", 3490, same("Size", W, 3490), "Satin cami and shorts set.", "Silky satin."),
    ("Nightwear", "Men's Lounge Shorts", "VORA Men", 1490, [("Pack", "1 pc", 1490), ("Pack", "2 pcs", 2690), ("Pack", "3 pcs", 3690)], "Cotton lounge shorts. Buy more and save.", "Pack of 2 or 3 saves more."),
    ("Nightwear", "House Frock (Free size)", "VORA", 1690, None, "Cotton house dress, free size.", "Comfortable home wear."),
    # ── Accessories ──
    ("Accessories", "Printed Chiffon Scarf", "VORA", 1290, None, "Light chiffon scarf / shawl, 180 x 70 cm.", "Light and soft."),
    ("Accessories", "Leather Belt", "VORA Men", 2490, same("Size", ["30-32", "34-36", "38-40"], 2490), "Genuine leather belt with metal buckle.", "Genuine leather."),
    ("Accessories", "Canvas Tote Bag", "VORA", 1890, None, "Strong canvas tote with inner pocket.", "Strong and washable."),
    ("Accessories", "Baseball Cap", "VORA", 1490, None, "Cotton cap, adjustable back strap.", "Adjustable, one size."),
    ("Accessories", "Hair Scrunchie Pack (6 pcs)", "VORA", 690, None, "Satin and cotton scrunchies, 6 colours.", "Pack of 6."),
    ("Accessories", "Gift Voucher", "VORA", 5000, [("Value", "Rs 2,500", 2500), ("Value", "Rs 5,000", 5000), ("Value", "Rs 10,000", 10000)], "Digital gift voucher sent on WhatsApp. Valid 6 months.", "Instant, no delivery needed."),
    ("Accessories", "Clutch Purse", "VORA", 2990, None, "Party clutch with chain strap.", "Fits phone and cards."),
    ("Accessories", "Ankle Socks (3 pairs)", "VORA Essentials", 790, None, "Cotton ankle socks, pack of 3, free size.", "Pack of 3."),
    # ── Sale ──
    ("Sale", "Last Season Maxi (Sale)", "VORA", 2990, same("Size", ["S", "M"], 2990), "Last season floral maxi. Only S and M left. No exchange on sale items.", "Sale price – was Rs 5,490."),
]
SOLD_OUT = {"Little Black Party Dress": ["XL"], "Basic Cotton Tee": ["Pink / XL"], "Slim Fit Jeans": ["38"], "Girls Frock": ["10-11Y"], "Oxford Cotton Shirt": ["Pink / XXL"]}
NOT_AVAILABLE = {"Clutch Purse"}  # whole product out of stock

ZONES = [  # (area, fee, days) – by location only, no weight
    ("Colombo 1-15", 300, "1-2 days"),
    ("Dehiwala, Mount Lavinia, Nugegoda, Kotte, Maharagama, Battaramulla, Rajagiriya, Wattala, Kelaniya", 350, "1-2 days"),
    ("Gampaha, Negombo, Ja-Ela, Kadawatha, Kiribathgoda", 400, "2-3 days"),
    ("Kalutara, Panadura, Moratuwa, Horana", 400, "2-3 days"),
    ("Kandy, Kurunegala, Matale", 450, "2-3 days"),
    ("Galle, Matara, Hambantota", 450, "2-3 days"),
    ("Jaffna, Vavuniya, Trincomalee, Batticaloa, Ampara", 550, "3-4 days"),
    ("*", 450, "2-4 days"),
]

KNOWLEDGE = [
    ("policy", "How do I pay?", "Cash on delivery island-wide, bank transfer, or card / Koko on the website link. For bank transfer, send the slip here."),
    ("policy", "Delivery charges?", "Colombo 1-15 Rs 300, Colombo suburbs Rs 350, most other areas Rs 400-450, North & East Rs 550. FREE delivery for orders over Rs 10,000."),
    ("policy", "Exchange policy?", "Size or colour exchange within 7 days if the item is unused with tags. Sale items cannot be exchanged. We do not give cash refunds, only exchange or store credit."),
    ("policy", "Damaged or wrong item?", "Send a photo within 2 days of delivery. We send the correct item free of charge."),
    ("faq", "Size guide (women)?", "S fits bust 32-34, M 34-36, L 36-38, XL 38-40, XXL 40-42 inches. Jeans waist size = your waist in inches. If between two sizes, take the bigger one."),
    ("faq", "Size guide (men)?", "Shirts/tees: M chest 38-40, L 40-42, XL 42-44, XXL 44-46. Formal shirts by collar: 15, 15.5, 16, 16.5, 17. Jeans & chinos by waist 30-38."),
    ("faq", "Kids sizes?", "Sizes by age: 2-3Y, 4-5Y, 6-7Y, 8-9Y, 10-11Y. If your child is tall, take one size up."),
    ("faq", "Do you have a shop?", "We are online, and we deliver island-wide. Pick-up is possible from our Colombo 5 warehouse on weekdays by appointment."),
    ("faq", "Can I see more photos or a video?", "Yes, ask for any product and we send real photos. Our team can send a video on request."),
    ("faq", "Do you do wholesale?", "Yes, for 20+ pieces. Ask for the wholesale price list and our team will contact you."),
    ("faq", "Fabric care?", "Wash in cold water, inside out. Do not bleach. Linen and satin: gentle wash, iron on low heat."),
    ("faq", "How long to deliver?", "Colombo 1-2 days, most areas 2-3 days, North & East 3-4 days. Orders before 2 pm are sent the same day."),
    ("style", "Is it original / good quality?", "All VORA clothes are made with quality fabric and checked before sending. If you are not happy with the size, you can exchange it within 7 days."),
    ("style", "Mata ganan kiyada? (price please)", "Price eka product eka langa thiyenawa 😊 Size eka kiyanna, mama check karala kiyannam. Colombo delivery Rs 300."),
]


def main():
    cats = sorted({p[0] for p in P})
    print(f"""-- VORA demo shop (clothing) – generated by scripts/make-vora-demo.py
-- {len(P)} products, {len(cats)} categories, {len(ZONES)} delivery zones (by location, no weight), {len(KNOWLEDGE)} knowledge items.
-- Only the company named '{COMPANY}' is changed. Running again replaces VORA's products (SKU VORA-...), delivery zones and knowledge.
-- Run: psql -h localhost -p 5433 -U agentmetra -d agentmetra -v ON_ERROR_STOP=1 -f vora-demo.sql
BEGIN;
SET search_path = public;
DO $$
DECLARE
  cid BIGINT; uid BIGINT; ind BIGINT; cat_ids JSONB := '{{}}'::jsonb; cat_id INT; pid INT; n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM companies WHERE company_name = {q(COMPANY)};
  IF n <> 1 THEN RAISE EXCEPTION 'Expected exactly one company named {COMPANY}, found %', n; END IF;
  SELECT id, admin_user_id INTO cid, uid FROM companies WHERE company_name = {q(COMPANY)};
  IF uid IS NULL THEN SELECT id INTO uid FROM app_user WHERE company_id = cid ORDER BY id LIMIT 1; END IF;

  -- company: clothing shop
  SELECT id INTO ind FROM industry WHERE LOWER(name) = 'fashion and clothing' LIMIT 1;
  IF ind IS NULL THEN INSERT INTO industry (name, is_active) VALUES ('Fashion and clothing', TRUE) RETURNING id INTO ind; END IF;
  UPDATE companies SET industry_id = ind, business_category = 'product', bot_enabled = TRUE,
    address = CASE WHEN COALESCE(address, '') = '' THEN 'Colombo 05, Sri Lanka' ELSE address END, updated_at = NOW()
  WHERE id = cid;

  -- bot settings
  INSERT INTO bot_sales_settings (company_id, bot_name, tone, default_language, greeting, about, opening_hours, payment_methods, auto_enable_new_customers, sells, free_delivery_over)
  VALUES (cid, 'VORA', 'friendly, short, helpful, a little stylish', 'auto',
    'Hi 👋 Welcome to VORA! Looking for something for you, him or the kids? Tell me what you like and your size 😊',
    'VORA is a Sri Lankan online clothing store: women''s dresses, tops, ethnic wear, men''s shirts, tees, jeans, sarongs, kids wear, nightwear and accessories. Island-wide delivery, cash on delivery, 7-day size exchange.',
    'Every day 9 am - 9 pm (orders on WhatsApp any time)', 'Cash on delivery, bank transfer, card, Koko', TRUE, 'products', 10000)
  ON CONFLICT (company_id) DO UPDATE SET bot_name = EXCLUDED.bot_name, tone = EXCLUDED.tone, greeting = EXCLUDED.greeting, about = EXCLUDED.about,
    opening_hours = EXCLUDED.opening_hours, payment_methods = EXCLUDED.payment_methods, sells = EXCLUDED.sells, free_delivery_over = EXCLUDED.free_delivery_over, updated_at = NOW();

  -- clear an older VORA demo copy
  DELETE FROM product_variant WHERE product_id IN (SELECT id FROM product WHERE company_id = cid AND sku LIKE 'VORA-%');
  DELETE FROM product WHERE company_id = cid AND sku LIKE 'VORA-%';
  DELETE FROM bot_delivery_zone WHERE company_id = cid;
  DELETE FROM bot_training_data WHERE company_id = cid;

  -- delivery by location (no weight charges)""")
    for area, fee, days in ZONES:
        print(f"  INSERT INTO bot_delivery_zone (company_id, area, fee, days, included_kg, per_extra_kg) VALUES (cid, {q(area)}, {fee}, {q(days)}, NULL, NULL);")
    print("\n  -- categories (re-used if they already exist)")
    for c in cats:
        print(f"  SELECT id INTO cat_id FROM product_catergory WHERE company_id = cid AND name = {q(c)} LIMIT 1;")
        print(f"  IF cat_id IS NULL THEN INSERT INTO product_catergory (name, company_id, is_active) VALUES ({q(c)}, cid, TRUE) RETURNING id INTO cat_id; END IF;")
        print(f"  cat_ids := cat_ids || jsonb_build_object({q(c)}, cat_id); cat_id := NULL;")
    print("\n  -- products")
    for i, (cat, name, brand, price, variants, desc, sp) in enumerate(P):
        sku = f"VORA-{i + 1:03d}"
        available = name not in NOT_AVAILABLE
        if variants:
            opts = []
            for j, (vn, vv, vp) in enumerate(variants):
                ok = available and vv not in SOLD_OUT.get(name, [])
                opts.append({"variant_name": vn, "variant_value": vv, "price": vp, "sku": f"{sku}-{j + 1:02d}",
                             "quantity": rnd.randint(3, 25) if ok else 0, "available": ok})
            qty = sum(o["quantity"] for o in opts)
            base = min(o["price"] for o in opts)
        else:
            qty = rnd.randint(8, 60) if available else 0
            base = price
        print(f"  INSERT INTO product (name, brand, description, sku, price, quantity, status, category_id, company_id, created_by, has_variants, weight, selling_points, is_available, show_to_bot) "
              f"VALUES ({q(name)}, {q(brand)}, {q(desc)}, {q(sku)}, {base}, {qty}, {q('In Stock' if available else 'Out of Stock')}, (cat_ids->>{q(cat)})::int, cid, uid, "
              f"{q(bool(variants))}, NULL, {q(sp)}, {q(available)}, TRUE) RETURNING id INTO pid;")
        if variants:
            print(f"  INSERT INTO product_variant (product_id, variants) VALUES (pid, {q(json.dumps(opts, ensure_ascii=False))}::jsonb);")
    print("\n  -- shop knowledge")
    for cat, qq, a in KNOWLEDGE:
        print(f"  INSERT INTO bot_training_data (company_id, category, question, answer, language, is_active) VALUES (cid, {q(cat)}, {q(qq)}, {q(a)}, 'auto', TRUE);")
    print("""END $$;
COMMIT;

-- check:
-- SELECT c.name, COUNT(p.id) FROM product p JOIN product_catergory c ON c.id = p.category_id JOIN companies co ON co.id = p.company_id WHERE co.company_name = 'VORA' GROUP BY 1 ORDER BY 1;""")


if __name__ == "__main__":
    main()
