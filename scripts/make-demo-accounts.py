#!/usr/bin/env python3
"""Makes demo-accounts.sql: 10 DEMO companies (shops, salon, clinic, villa, courier ...) each with an admin + agent login.

Run:  python3 scripts/make-demo-accounts.py > demo-accounts.sql
Load: psql -h localhost -p 5433 -U agentmetra -d agentmetra -v ON_ERROR_STOP=1 -f demo-accounts.sql
Running it again deletes these 10 demo companies first (only the @demo.test logins below are touched).
Password for all logins: DEMO_PASSWORD env (default 12345678).
"""
import hashlib
import json
import os
import random

PASSWORD = os.environ.get("DEMO_PASSWORD", "12345678")
rnd = random.Random(1018)


def scrypt_hash(password: str) -> str:
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


ZONES = [("Colombo", 350, "1-2 days"), ("Gampaha", 400, "2-3 days"), ("Kandy", 450, "2-3 days"), ("Galle", 450, "2-3 days"), ("*", 500, "2-4 days")]
POLICY = [
    ("How do I pay?", "Bank transfer or cash on delivery. Send the slip after a bank transfer."),
    ("Do you have a return policy?", "Wrong or damaged items can be exchanged within 7 days with the bill."),
]


def baby_products():
    rows = [
        ("Diapers", "Diapers Pack (40 pcs)", "Pampers", 2450, 1.2, [("Newborn", 2450), ("Size S", 2450), ("Size M", 2650), ("Size L", 2850)]),
        ("Baby care", "Baby Wipes (80 pcs)", "Johnson's", 390, 0.4, None), ("Baby care", "Baby Lotion 200ml", "Johnson's", 890, 0.25, None),
        ("Baby care", "Baby Soap", "Baby Cheramy", 290, 0.1, None), ("Baby care", "Baby Shampoo 200ml", "Johnson's", 750, 0.25, None),
        ("Clothes", "Cotton Romper Set (3 pcs)", "Little Steps", 2200, 0.4, [("0-3 months", 2200), ("3-6 months", 2200), ("6-12 months", 2300)]),
        ("Clothes", "Baby Mittens & Socks Set", "Little Steps", 650, 0.1, None), ("Feeding", "Feeding Bottle 250ml", "Pigeon", 1450, 0.2, None),
        ("Feeding", "Silicone Bib", "Pigeon", 850, 0.1, None), ("Feeding", "Sippy Cup", "Pigeon", 1250, 0.2, None),
        ("Gear", "Baby Carrier", "Chicco", 6900, 0.8, None), ("Gear", "Foldable Baby Bath Tub", "Little Steps", 4500, 1.5, None),
        ("Toys", "Soft Rattle Set (4 pcs)", "Little Steps", 1150, 0.3, None),
    ]
    return [dict(cat=c, name=n, brand=b, price=p, kg=kg, variants=v) for c, n, b, p, kg, v in rows]


def phone_products():
    out = []
    phones = [("Samsung", ["Galaxy A15", "Galaxy A25", "Galaxy A35", "Galaxy A55", "Galaxy S24", "Galaxy S24 Ultra", "Galaxy Z Flip6"]),
              ("Apple", ["iPhone 13", "iPhone 14", "iPhone 15", "iPhone 15 Pro", "iPhone 16", "iPhone 16 Pro Max"]),
              ("Xiaomi", ["Redmi 13C", "Redmi Note 13", "Redmi Note 13 Pro", "Xiaomi 14T"]),
              ("Oppo", ["A18", "A79", "Reno 12"]), ("Vivo", ["Y18", "Y28", "V30"]), ("Realme", ["C67", "12 Pro"])]
    base = {"Galaxy A15": 46900, "Galaxy A25": 62900, "Galaxy A35": 89900, "Galaxy A55": 119900, "Galaxy S24": 234900, "Galaxy S24 Ultra": 389900, "Galaxy Z Flip6": 329900,
            "iPhone 13": 189900, "iPhone 14": 219900, "iPhone 15": 259900, "iPhone 15 Pro": 359900, "iPhone 16": 299900, "iPhone 16 Pro Max": 469900}
    for brand, models in phones:
        for m in models:
            p = base.get(m, rnd.randrange(35, 140) * 1000 - 100)
            out.append(dict(cat="Phones", name=f"{brand} {m}", brand=brand, price=p, kg=0.5,
                            variants=[("128GB", p), ("256GB", p + round(p * 0.12, -2))]))
    acc = [("Cases", "Silicone Case", 1490), ("Cases", "Clear Shockproof Case", 1290), ("Screen protectors", "Tempered Glass", 790)]
    for brand, models in phones[:3]:
        for m in models:
            for cat, kind, price in acc:
                out.append(dict(cat=cat, name=f"{kind} – {brand} {m}", brand="TechZone", price=price, kg=0.1, variants=None))
    extras = [("Chargers", "Anker", "20W USB-C Fast Charger", 4500), ("Chargers", "Samsung", "25W Super Fast Charger", 5900), ("Chargers", "Apple", "20W USB-C Power Adapter", 7900),
              ("Chargers", "Baseus", "65W GaN Charger", 9900), ("Cables", "Anker", "USB-C to USB-C Cable 1m", 1900), ("Cables", "Apple", "USB-C to Lightning Cable", 4900),
              ("Cables", "Baseus", "3-in-1 Cable", 1500), ("Power banks", "Anker", "Power Bank 10000mAh", 7900), ("Power banks", "Xiaomi", "Power Bank 20000mAh", 8900),
              ("Power banks", "Baseus", "Magnetic Power Bank 5000mAh", 8500), ("Audio", "JBL", "Tune 520BT Headphones", 16900), ("Audio", "Apple", "AirPods 4", 54900),
              ("Audio", "Samsung", "Galaxy Buds FE", 24900), ("Audio", "Xiaomi", "Redmi Buds 6 Active", 5900), ("Audio", "JBL", "Go 4 Speaker", 15900),
              ("Watches", "Samsung", "Galaxy Watch 7", 79900), ("Watches", "Xiaomi", "Redmi Watch 4", 24900), ("Watches", "Apple", "Apple Watch SE", 99900),
              ("Accessories", "Baseus", "Car Phone Holder", 2900), ("Accessories", "Ugreen", "Phone Stand", 1900), ("Accessories", "Sandisk", "128GB microSD Card", 4500)]
    for cat, brand, name, price in extras:
        out.append(dict(cat=cat, name=f"{brand} {name}", brand=brand, price=price, kg=0.3, variants=None))
    while len(out) < 114:
        n = len(out)
        out.append(dict(cat="Cases", name=f"Leather Flip Case – Samsung {phones[0][1][n % 7]} ({['Black', 'Brown', 'Navy'][n % 3]})", brand="TechZone", price=1990, kg=0.1, variants=None))
    return out[:114]


def food_products():
    rows = [("Rice & curry", "Chicken Rice & Curry", 650), ("Rice & curry", "Fish Rice & Curry", 600), ("Rice & curry", "Vegetable Rice & Curry", 450),
            ("Kottu", "Chicken Kottu", 1100), ("Kottu", "Cheese Kottu", 1450), ("Fried rice", "Mixed Fried Rice", 1350), ("Fried rice", "Nasi Goreng", 1500),
            ("Biriyani", "Chicken Biriyani", 1400), ("Drinks", "Fresh Lime Juice", 350), ("Desserts", "Watalappan", 400)]
    return [dict(cat=c, name=n, brand=None, price=p, kg=0.6, variants=[("Normal", p), ("Large", p + 300)] if c in ("Kottu", "Fried rice") else None) for c, n, p in rows]


# (name, price, price_note, minutes, description)
S = {
    "glow": [("Hair cut (ladies)", 2500, "", 45, "Wash, cut and blow dry."), ("Hair cut (gents)", 1200, "", 30, "Cut and style."),
             ("Hair colour (full)", 9500, "from", 120, "Full colour, price depends on length."), ("Highlights", 12500, "from", 150, "Partial or full highlights."),
             ("Keratin treatment", 18500, "from", 180, "Smooth, frizz-free hair for 3-4 months."), ("Facial (basic)", 3500, "", 60, "Cleanse, scrub, mask."),
             ("Facial (gold)", 6500, "", 75, "Brightening gold facial."), ("Manicure", 2000, "", 40, "Nail shaping, cuticle care and polish."),
             ("Pedicure", 2500, "", 50, "Foot soak, scrub and polish."), ("Threading (eyebrows)", 300, "", 10, "Eyebrow shaping."),
             ("Bridal dressing", 45000, "from", 240, "Bridal hair, make-up and saree draping. Trial included."), ("Waxing (full legs)", 3500, "", 40, "Full leg waxing.")],
    "lankahomes": [("Land sale listing", 0, "free", None, "We list and advertise your land."), ("House rent finding", 15000, "one-time", None, "We find a house to rent for you."),
                   ("Property valuation", 25000, "", None, "Valuation report by a chartered valuer."), ("Deed & legal check", 35000, "from", None, "Lawyer checks deeds before you buy.")],
    "techzone": [("Screen replacement", 8500, "from", 60, "Price depends on the model."), ("Battery replacement", 6500, "from", 45, "Original-grade battery, 3 months warranty.")],
    "spicegarden": [("Table booking", 0, "free", 90, "Reserve a table for lunch or dinner."), ("Party catering", 1200, "per person", None, "Rice & curry buffet for 25+ people.")],
    "smilecare": [("Consultation", 2000, "", 20, "Check-up with the dentist."), ("Scaling & polishing", 6000, "", 40, "Cleaning of teeth."),
                  ("Tooth filling", 5000, "from", 40, "Tooth-coloured filling."), ("Tooth extraction", 4500, "from", 30, "Simple extraction."),
                  ("Root canal treatment", 25000, "from", 90, "Over 2-3 visits."), ("Teeth whitening", 30000, "", 60, "In-clinic whitening."),
                  ("Braces consultation", 3000, "", 30, "Check if braces are needed and the cost."), ("Metal braces", 180000, "from", None, "Full treatment, monthly visits."),
                  ("Kids dental check", 1500, "", 20, "For children under 12."), ("Dental X-ray", 1500, "", 10, "Small X-ray of one area.")],
    "brightfuture": [("IELTS course (3 months)", 45000, "", None, "Weekend classes, mock tests included."), ("Spoken English", 18000, "", None, "2 months, weekday evenings."),
                     ("O/L Maths", 3000, "per month", None, "Grade 10-11 group classes."), ("A/L ICT", 4000, "per month", None, "Theory and practicals."),
                     ("Diploma in IT", 85000, "", None, "6 months, certificate included."), ("Graphic Design", 35000, "", None, "Photoshop, Illustrator, Canva - 2 months."),
                     ("Kids Coding (Scratch)", 12000, "", None, "Ages 8-14, 8 weeks."), ("Online English (1-to-1)", 2500, "per hour", 60, "Book any time.")],
    "ellahill": [("Deluxe double room", 18000, "per night", None, "Mountain view, breakfast for 2."), ("Family room (4)", 26000, "per night", None, "2 beds, breakfast for 4."),
                 ("Whole villa (8 guests)", 85000, "per night", None, "4 rooms, private cook."), ("Airport pickup", 28000, "one way", None, "From BIA to Ella by car."),
                 ("Little Adam's Peak tour", 6000, "per group", 180, "Guided morning hike."), ("Dinner (rice & curry)", 2500, "per person", None, "Home-cooked Sri Lankan dinner.")],
    "safedrive": [("Car lease (new)", 0, "quote", None, "Up to 90% lease for brand new cars."), ("Car lease (used)", 0, "quote", None, "Registered vehicles up to 15 years old."),
                  ("Three-wheel lease", 0, "quote", None, "Up to 5 years."), ("Gold loan", 0, "quote", None, "Instant cash against gold."),
                  ("Leasing renewal / settle", 0, "quote", None, "Early settlement quotes.")],
    "quickship": [("Same-day Colombo delivery", 450, "up to 2 kg", None, "Order before 12 noon."), ("Island-wide delivery", 400, "up to 1 kg", None, "1-3 days."),
                  ("Cash on delivery collection", 0, "1% fee", None, "We collect cash and pay you weekly."), ("Bulk shop pickup", 0, "free", None, "Daily pickup for 10+ parcels."),
                  ("Return handling", 250, "per parcel", None, "Returns sent back to you.")],
}

K = {
    "littlesteps": [("Are the diapers original?", "Yes, all brands are original imports."), ("Which diaper size for 7 kg?", "Size M (6-11 kg) fits best."),
                    ("Do you deliver to Kandy?", "Yes, Rs 450, 2-3 days."), ("Can I visit the shop?", "Online only, we deliver island-wide."),
                    ("Do you have gift packs?", "Yes, baby gift boxes from Rs 4,500 with free gift wrap.")],
    "glow": [("Do I need an appointment?", "Yes, please book so we can keep your time."), ("Where are you?", "No. 45, Galle Road, Wellawatte."),
             ("Opening hours?", "Every day 9 am - 7 pm, closed on Poya days.")],
    "lankahomes": [("Where do you have lands?", "Mainly Gampaha, Kadawatha, Kiribathgoda and Negombo."), ("Do you help with bank loans?", "Yes, we connect you with housing loan officers."),
                   ("Is the deed clear?", "Every listing is checked by our lawyer before we advertise."), ("Commission?", "3% from the seller, nothing from the buyer."),
                   ("Can I visit the land?", "Yes, book a site visit, we take you there."), ("Office hours?", "Mon-Sat 8.30 am - 5.30 pm."), ("Where is the office?", "No. 12, Kandy Road, Kadawatha.")],
    "techzone": [("Warranty?", "Phones: 1 year company warranty. Accessories: 6 months."), ("Do you take old phones?", "Yes, exchange offers, send photos for a price."),
                 ("Card instalments?", "0% for 12 months with Commercial Bank and Sampath cards."), ("Where is the shop?", "Unity Plaza, Bambalapitiya, 2nd floor."),
                 ("Are phones brand new?", "Yes, sealed with the company warranty.")],
    "spicegarden": [("Opening hours?", "11 am - 10.30 pm every day."), ("Do you deliver?", "Yes, within 5 km, Rs 200."), ("Spicy?", "Tell us mild, medium or hot.")],
    "smilecare": [("Is it painful?", "We use local anaesthesia, most treatments are painless."), ("Clinic hours?", "Mon-Sat 4 pm - 9 pm, Sun 9 am - 1 pm."),
                  ("Where is the clinic?", "No. 8, High Level Road, Nugegoda.")],
    "brightfuture": [("Online or physical?", "Both. Pick what suits you."), ("Do I get a certificate?", "Yes, for all courses."), ("Payment in parts?", "Yes, 2 or 3 instalments.")],
    "ellahill": [("Check-in time?", "From 2 pm, check-out by 11 am."), ("Is there hot water?", "Yes, in every room."),                  ("How far from Ella town?", "2 km, 5 minutes by tuk."), ("Advance?", "50% to confirm, rest on arrival.")],
    "safedrive": [("Documents?", "NIC, proof of income, utility bill and the vehicle quotation."), ("How fast?", "Approval in 24 hours for most customers."),
                  ("Interest rate?", "Depends on the vehicle and period, ask for a quote.")],
    "quickship": [("Where to drop parcels?", "No. 22, Baseline Road, Colombo 9, or we pick up."), ("Track my parcel?", "Send the tracking number, we check."),
                  ("When do you pay COD money?", "Every Wednesday to your bank account.")],
}

SHOPS = [
    dict(key="littlesteps", name="Little Steps Baby Shop", cat="product", plan="growth", industry="Baby and kids", products=baby_products, zones=4,
         about="Online baby shop – diapers, baby care, clothes and gear. Island-wide delivery.", hours="Every day 8 am - 9 pm", pay="Bank transfer, cash on delivery"),
    dict(key="glow", name="Glow Beauty Salon", cat="service", plan="free", industry="Salon and spa", about="Ladies & gents salon in Wellawatte.", hours="9 am - 7 pm", pay="Cash, card"),
    dict(key="lankahomes", name="Lanka Homes", cat="service", plan="free", industry="Real estate", about="Lands and houses for sale and rent in Gampaha district.", hours="Mon-Sat 8.30 am - 5.30 pm", pay="Bank transfer"),
    dict(key="techzone", name="TechZone Mobile", cat="product", plan="scale", industry="Mobile phones and accessories", products=phone_products, zones=3,
         about="Brand new phones and accessories with warranty. Repairs too.", hours="Every day 10 am - 8 pm", pay="Bank transfer, card, cash on delivery, 0% instalments"),
    dict(key="spicegarden", name="Spice Garden Restaurant", cat="both", plan="growth", industry="Restaurant and cafe", products=food_products, zones=5,
         about="Sri Lankan restaurant – rice & curry, kottu, biriyani. Takeaway, delivery and catering.", hours="11 am - 10.30 pm", pay="Cash, card, bank transfer"),
    dict(key="smilecare", name="SmileCare Dental Clinic", cat="service", plan="free", industry="Health clinic", about="Family dental clinic in Nugegoda.", hours="Mon-Sat 4-9 pm, Sun 9 am-1 pm", pay="Cash, card"),
    dict(key="brightfuture", name="Bright Future Institute", cat="service", plan="free", industry="Education", about="English, IT and school classes – online and in class.", hours="Mon-Sun 8 am - 8 pm", pay="Bank transfer, cash"),
    dict(key="ellahill", name="Ella Hill Villa", cat="service", plan="free", industry="Hotels and stays", about="Small villa with mountain views, 2 km from Ella town.", hours="24 hours", pay="Bank transfer, card"),
    dict(key="safedrive", name="SafeDrive Leasing", cat="service", plan="free", industry="Insurance and finance", about="Vehicle leasing and gold loans.", hours="Mon-Fri 8.30 am - 5 pm, Sat 8.30 am - 1 pm", pay="Bank transfer"),
    dict(key="quickship", name="QuickShip Courier", cat="service", plan="free", industry="Delivery and courier", about="Courier for online shops – same-day Colombo, island-wide, COD.", hours="Mon-Sat 8 am - 6 pm", pay="Bank transfer, cash"),
]
SELLS = {"product": "products", "service": "services", "both": "both"}


def main():
    pw = scrypt_hash(PASSWORD)
    emails = []
    for s in SHOPS:
        emails += [f"{s['key']}@demo.test", f"{s['key']}.agent@demo.test"]
    elist = ", ".join(q(e) for e in emails)
    print(f"""-- Agent Metra – 10 DEMO companies (generated by scripts/make-demo-accounts.py)
-- Every company has an admin login <name>@demo.test and an agent login <name>.agent@demo.test. Password for all: {PASSWORD}
-- Run on the VPS:  psql -h localhost -p 5433 -U agentmetra -d agentmetra -v ON_ERROR_STOP=1 -f demo-accounts.sql
-- Running it again deletes these 10 demo companies first (only the @demo.test logins are touched).
BEGIN;
SET search_path = public;

CREATE TEMP TABLE _old ON COMMIT DROP AS SELECT DISTINCT company_id AS id FROM app_user WHERE email IN ({elist}) AND company_id IS NOT NULL;
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
DELETE FROM bot_service WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_delivery_zone WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_training_data WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_sales_settings WHERE company_id IN (SELECT id FROM _old);
DELETE FROM company_subscription WHERE company_id IN (SELECT id FROM _old);
UPDATE companies SET admin_user_id = NULL WHERE id IN (SELECT id FROM _old);
DELETE FROM app_user WHERE email IN ({elist});
DELETE FROM companies WHERE id IN (SELECT id FROM _old);
""")
    for n, s in enumerate(SHOPS):
        key = s["key"]
        products = s.get("products", lambda: [])()
        services = S.get(key, [])
        knowledge = POLICY + K[key] if s["cat"] != "service" else POLICY[:1] + K[key] + [("Do you have a WhatsApp number?", "Yes, this chat is our WhatsApp. Message us any time.")]
        print(f"\n-- ───────── {s['name']} ({s['cat']}, {len(products)} products, {len(services)} services, {s.get('zones', 0)} zones, {len(knowledge)} knowledge) ─────────")
        print(f"""DO $$
DECLARE
  cid BIGINT; uid INT; aid INT; pkg INT; pcode TEXT; ind BIGINT; cat_ids JSONB := '{{}}'::jsonb; cat_id INT; pid INT;
BEGIN
  SELECT id, code INTO pkg, pcode FROM platform_package WHERE code = {q(s['plan'])} LIMIT 1;
  IF pkg IS NULL AND {q(s['plan'])} = 'scale' THEN SELECT id, code INTO pkg, pcode FROM platform_package WHERE code = 'pro' LIMIT 1; END IF;
  IF pkg IS NULL THEN SELECT id, code INTO pkg, pcode FROM platform_package ORDER BY sort_order LIMIT 1; END IF;
  SELECT id INTO ind FROM industry WHERE LOWER(name) = LOWER({q(s['industry'])}) LIMIT 1;
  IF ind IS NULL THEN INSERT INTO industry (name, is_active) VALUES ({q(s['industry'])}, TRUE) RETURNING id INTO ind; END IF;
  INSERT INTO companies (company_name, status, plan, email, phone, address, business_category, industry_id, bot_enabled)
    VALUES ({q(s['name'])}, 'ACTIVE', pcode, {q(key + '@demo.test')}, '07710000{n:02d}', 'Colombo', {q(s['cat'])}, ind, TRUE) RETURNING id INTO cid;
  INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, whatsapp_number, whatsapp_verified_at, team_role)
    VALUES ({q(s['name'] + ' Admin')}, {q(key + '@demo.test')}, {q(pw)}, TRUE, cid, NOW(), '947710000{n:02d}', NOW(), 'owner') RETURNING id INTO uid;
  INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, team_role, is_agent_active)
    VALUES ({q(s['name'] + ' Agent')}, {q(key + '.agent@demo.test')}, {q(pw)}, TRUE, cid, NOW(), 'agent', TRUE) RETURNING id INTO aid;
  UPDATE companies SET admin_user_id = uid WHERE id = cid;
  INSERT INTO company_subscription (company_id, package_id, billing_cycle, status, period_start, period_end, token_period_start, token_period_end, auto_renew)
    VALUES (cid, pkg, 'monthly', 'active', NOW(), NOW() + INTERVAL '30 days', NOW(), NOW() + INTERVAL '30 days', FALSE);
  INSERT INTO bot_sales_settings (company_id, tone, default_language, about, opening_hours, payment_methods, auto_enable_new_customers, sells)
    VALUES (cid, 'friendly, short, helpful', 'auto', {q(s['about'])}, {q(s['hours'])}, {q(s['pay'])}, TRUE, {q(SELLS[s['cat']])});""")
        zones = ZONES[:s.get("zones", 0)]
        if zones and zones[-1][0] != "*" and s.get("zones", 0) >= 3:
            zones = zones[:-1] + [("*", 500, "2-4 days")]
        for area, fee, days in zones:
            print(f"  INSERT INTO bot_delivery_zone (company_id, area, fee, days, included_kg, per_extra_kg) VALUES (cid, {q(area)}, {fee}, {q(days)}, 2, 80);")
        for c in sorted({p["cat"] for p in products}):
            print(f"  INSERT INTO product_catergory (name, company_id, is_active) VALUES ({q(c)}, cid, TRUE) RETURNING id INTO cat_id; cat_ids := cat_ids || jsonb_build_object({q(c)}, cat_id);")
        for i, p in enumerate(products):
            sku = f"{key[:3].upper()}-{i + 1:04d}"
            print(f"  INSERT INTO product (name, brand, description, sku, price, quantity, status, category_id, company_id, created_by, has_variants, weight, selling_points, is_available, show_to_bot) "
                  f"VALUES ({q(p['name'])}, {q(p['brand'])}, {q(p['name'] + '.')}, {q(sku)}, {p['price']}, {rnd.randint(3, 40)}, 'In Stock', "
                  f"(cat_ids->>{q(p['cat'])})::int, cid, uid, {q(bool(p['variants']))}, {p['kg']}, '', TRUE, TRUE) RETURNING id INTO pid;")
            if p["variants"]:
                vname = {"Phones": "Storage", "Diapers": "Size", "Clothes": "Age"}.get(p["cat"], "Portion")
                vs = [{"variant_name": vname, "variant_value": v, "price": pr, "sku": f"{sku}-{j + 1}", "quantity": rnd.randint(2, 20), "weight": p["kg"]} for j, (v, pr) in enumerate(p["variants"])]
                print(f"  INSERT INTO product_variant (product_id, variants) VALUES (pid, {q(json.dumps(vs, ensure_ascii=False))}::jsonb);")
        for name, price, note, mins, desc in services:
            print(f"  INSERT INTO bot_service (company_id, name, description, price, price_note, duration_min, is_active, is_available) VALUES (cid, {q(name)}, {q(desc)}, {price}, {q(note)}, {q(mins)}, TRUE, TRUE);")
        for qq, a in knowledge:
            print(f"  INSERT INTO bot_training_data (company_id, category, question, answer, language, is_active) VALUES (cid, 'faq', {q(qq)}, {q(a)}, 'auto', TRUE);")
        print("END $$;")
    print("\nCOMMIT;")
    print("""
-- check:
-- SELECT c.company_name, c.business_category, c.plan,
--   (SELECT COUNT(*) FROM product p WHERE p.company_id = c.id) products, (SELECT COUNT(*) FROM bot_service s WHERE s.company_id = c.id) services,
--   (SELECT COUNT(*) FROM bot_delivery_zone z WHERE z.company_id = c.id) zones, (SELECT COUNT(*) FROM bot_training_data t WHERE t.company_id = c.id) knowledge
-- FROM companies c WHERE c.email LIKE '%@demo.test' ORDER BY c.id;""")


if __name__ == "__main__":
    main()
