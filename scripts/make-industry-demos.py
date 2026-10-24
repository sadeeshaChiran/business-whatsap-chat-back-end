#!/usr/bin/env python3
"""Makes 02-industry-demos.sql: the Agent Metra company account + 7 industry demo companies.

  Agent Metra itself  agentmetra@gmail.com          sells Agent Metra packages (services) – the sales bot on our own WhatsApp
  Online shop         novagadgets@demo.test         Nova Gadgets – electronics and lifestyle online store (products)
  Education           brightpath@demo.test          Bright Path Campus – courses, classes, counselling (services)
  Beauty and health   glowandgo@demo.test           Glow & Go Beauty Studio – salon services + skincare shop (both)
  Food                spiceroute@demo.test          Spice Route Kitchen – delivery menu + table booking and catering (both)
  Travel and tourism  islandtrails@demo.test        Island Trails Travel – tours, hotels, transfers (services)
  Weddings and events goldenvows@demo.test          Golden Vows Weddings & Events – packages and consultations (services)
  High-value sales    apexsolar@demo.test           Apex Solar Energy – solar systems, batteries, site visits (both)

Each demo company has an owner login <key>@demo.test and an agent login <key>.agent@demo.test.
Password for every login (Agent Metra too): DEMO_PASSWORD env, default 12345678.

This file creates the companies, logins, packages, product categories and products.
Bot settings, delivery zones, services and training come from scripts/bot-training/clients/<key>.json
(see scripts/make-final-data.sh, which runs everything in the right order).

Safe to run again: demo companies (@demo.test) are deleted and made again; the Agent Metra company is
kept and only updated (its chats and customers stay).

Run:  python3 scripts/make-industry-demos.py > 02-industry-demos.sql
"""
import hashlib
import json
import os
import random

PASSWORD = os.environ.get("DEMO_PASSWORD", "12345678")
rnd = random.Random(2410)


def scrypt_hash(password: str) -> str:
    # same as AuthService.hashPassword: scrypt(password, <salt hex string>, 64) with Node defaults N=16384 r=8 p=1
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


# ───────────────────────── catalogs ─────────────────────────
# product: (category, name, brand, price, kg, description, selling points, variants)
# variants: None or (variant_name, [(value, price), ...])

NOVA = [
    ("Earbuds and audio", "Nova Pods Pro ANC Earbuds", "Nova", 8900, 0.2, "Active noise cancelling earbuds, 30 h battery with the case, USB-C.", "ANC; transparency mode; IPX5 sweat proof; 1 year warranty", ("Colour", [("Black", 8900), ("White", 8900)])),
    ("Earbuds and audio", "JBL Tune 520BT Headphones", "JBL", 16900, 0.4, "On-ear wireless headphones with JBL Pure Bass, 57 h battery.", "57 h battery; foldable; multi-point; 1 year warranty", ("Colour", [("Black", 16900), ("Blue", 16900), ("White", 16900)])),
    ("Earbuds and audio", "Redmi Buds 6 Active", "Xiaomi", 5900, 0.15, "Budget true wireless earbuds with 30 h playback.", "Light; clear calls; 6 months warranty", None),
    ("Earbuds and audio", "JBL Go 4 Bluetooth Speaker", "JBL", 15900, 0.3, "Pocket speaker, IP67 waterproof, 7 h battery.", "Waterproof; strap included; 1 year warranty", ("Colour", [("Black", 15900), ("Red", 15900), ("Blue", 15900)])),
    ("Earbuds and audio", "Nova Soundbar 2.1 (120W)", "Nova", 29900, 4.5, "TV soundbar with wireless subwoofer, HDMI ARC and Bluetooth.", "120 W; remote included; wall mount kit", None),
    ("Smart watches", "Nova Fit Watch S2", "Nova", 11900, 0.2, "1.9\" AMOLED smartwatch, calls, heart rate, SpO2, 10-day battery.", "Bluetooth calls; Sinhala notifications; 1 year warranty", ("Strap", [("Black silicone", 11900), ("Pink silicone", 11900), ("Steel mesh", 13400)])),
    ("Smart watches", "Redmi Watch 4", "Xiaomi", 24900, 0.2, "AMOLED, GPS, 20-day battery.", "Built-in GPS; 150 sport modes", None),
    ("Smart watches", "Samsung Galaxy Watch 7 (40mm)", "Samsung", 79900, 0.2, "Wear OS watch with sleep and health tracking.", "Company warranty 1 year", ("Colour", [("Green", 79900), ("Cream", 79900)])),
    ("Chargers and power", "Anker 20W USB-C Fast Charger", "Anker", 4500, 0.1, "Fast charger for iPhone and Android.", "PD 20W; 18 months warranty", None),
    ("Chargers and power", "Baseus 65W GaN 3-port Charger", "Baseus", 9900, 0.2, "Charges a laptop, phone and earbuds together.", "2x USB-C + USB-A; compact GaN", None),
    ("Chargers and power", "Anker Power Bank 10000mAh", "Anker", 7900, 0.25, "Slim power bank, 20W fast charge.", "Charges an iPhone about 2 times", None),
    ("Chargers and power", "Xiaomi Power Bank 20000mAh", "Xiaomi", 8900, 0.45, "High-capacity power bank, 22.5W.", "Charges most phones 4 times", None),
    ("Chargers and power", "Nova 3-in-1 Wireless Charging Stand", "Nova", 12500, 0.5, "Charges phone, watch and earbuds at once.", "15W; works with iPhone and Samsung", None),
    ("Cables and hubs", "Anker USB-C to USB-C Cable (1m)", "Anker", 1900, 0.05, "100W braided cable.", "Braided; 100W", None),
    ("Cables and hubs", "Ugreen USB-C 7-in-1 Hub", "Ugreen", 11900, 0.15, "HDMI 4K, 3x USB-A, SD card, PD charging.", "For MacBook and Windows laptops", None),
    ("Smart home", "Nova WiFi Smart Bulb (pack of 2)", "Nova", 3900, 0.3, "16 million colours, works with the phone app and Google Home.", "Voice control; schedules", None),
    ("Smart home", "TP-Link Tapo C200 WiFi Camera", "TP-Link", 11900, 0.4, "1080p indoor camera, night vision, 360° pan.", "Phone alerts; 2-way talk; SD card up to 256GB", None),
    ("Smart home", "TP-Link Deco M4 Mesh WiFi (2 pack)", "TP-Link", 29900, 1.2, "Whole-home mesh WiFi for 2-3 storey houses.", "Covers up to 2,800 sq ft", None),
    ("Smart home", "Xiaomi Robot Vacuum E10", "Xiaomi", 64900, 4.0, "Robot vacuum and mop, app control, 2 h battery.", "4000Pa suction; auto return to dock", None),
    ("Kitchen gadgets", "Nova Air Fryer 5.5L", "Nova", 24900, 5.0, "Digital air fryer, 8 presets, non-stick basket.", "Less oil; dishwasher safe basket; 1 year warranty", None),
    ("Kitchen gadgets", "Philips Hand Blender 650W", "Philips", 15900, 1.2, "Hand blender with chopper and whisk.", "2 years warranty", None),
    ("Kitchen gadgets", "Nova Electric Kettle 1.7L (Glass)", "Nova", 6900, 1.3, "Blue LED glass kettle, auto off.", "Boil-dry protection", None),
    ("Computer accessories", "Logitech M331 Silent Mouse", "Logitech", 4900, 0.1, "Wireless silent-click mouse.", "Up to 24 months battery", ("Colour", [("Black", 4900), ("Red", 4900), ("Blue", 4900)])),
    ("Computer accessories", "Logitech K380 Bluetooth Keyboard", "Logitech", 12900, 0.4, "Compact multi-device keyboard.", "Switch between 3 devices", None),
    ("Computer accessories", "Nova Laptop Stand (Aluminium)", "Nova", 5900, 0.8, "Adjustable laptop riser, folds flat.", "Fits 10-17 inch laptops", None),
    ("Computer accessories", "SanDisk 128GB microSD Card", "SanDisk", 4500, 0.02, "A2 card for phones, cameras and Switch.", "Up to 190 MB/s", None),
    ("Phone accessories", "Nova MagSafe Clear Case", "Nova", 2900, 0.08, "Clear case with magnetic ring, anti-yellow.", "Works with MagSafe chargers", ("Model", [("iPhone 15", 2900), ("iPhone 15 Pro", 2900), ("iPhone 16", 2900), ("iPhone 16 Pro", 2900)])),
    ("Phone accessories", "Tempered Glass Screen Guard", "Nova", 990, 0.03, "9H glass with fitting frame.", "Free fitting at the store", ("Model", [("iPhone 15 / 16", 990), ("Galaxy A55", 990), ("Galaxy S24", 1290), ("Redmi Note 13", 990)])),
    ("Phone accessories", "Baseus Car Phone Holder", "Baseus", 2900, 0.2, "Air-vent magnetic car mount.", "One-hand use", None),
    ("Gaming", "Nova Wireless Game Controller", "Nova", 6900, 0.3, "For Android, PC and Switch, with phone clip.", "Bluetooth; 20 h battery", None),
    ("Gaming", "Redragon RGB Gaming Headset", "Redragon", 8900, 0.5, "7.1 surround sound, noise-cancelling mic.", "USB + 3.5 mm", None),
]

GLOW_PRODUCTS = [
    ("Skin care", "Vitamin C Brightening Serum 30ml", "Glow & Go", 3900, 0.1, "10% vitamin C serum for dull skin and dark spots.", "Use in the morning with sunscreen", None),
    ("Skin care", "Niacinamide 10% + Zinc Serum 30ml", "The Ordinary", 4500, 0.1, "For oily skin, pores and acne marks.", "Original import", None),
    ("Skin care", "Hydrating Gel Moisturiser 50ml", "Glow & Go", 2900, 0.1, "Light, non-greasy moisturiser for all skin types.", "Good for oily skin", None),
    ("Skin care", "Sunscreen SPF 50 PA++++ 50ml", "Glow & Go", 3200, 0.1, "Matte finish, no white cast.", "Daily use; under make-up", None),
    ("Skin care", "Gentle Foam Cleanser 150ml", "Cetaphil", 3600, 0.2, "Soap-free cleanser for sensitive skin.", "Dermatologist recommended", None),
    ("Skin care", "Glow Facial Kit (home use)", "Glow & Go", 5900, 0.4, "Cleanser, scrub, mask and serum – 4 facials.", "Gift box", None),
    ("Hair care", "Keratin Repair Shampoo 300ml", "Glow & Go", 2400, 0.35, "Sulphate-free shampoo for treated hair.", "Safe after keratin and colour", None),
    ("Hair care", "Argan Oil Hair Serum 50ml", "Glow & Go", 2200, 0.1, "Smooths frizz and adds shine.", "Use on damp hair", None),
    ("Hair care", "Onion Hair Oil 200ml", "Glow & Go", 1800, 0.25, "Reduces hair fall, strengthens roots.", "Warm massage, 2-3 times a week", None),
    ("Nails", "Gel Polish Set (6 colours)", "Glow & Go", 4900, 0.3, "Long-lasting gel colours, needs a UV lamp.", "Lasts 2-3 weeks", None),
    ("Gift vouchers", "Spa Gift Voucher", "Glow & Go", 5000, 0.0, "Gift voucher for any service. Valid 6 months.", "Sent on WhatsApp", ("Value", [("Rs 5,000", 5000), ("Rs 10,000", 10000), ("Rs 20,000", 20000)])),
]

SPICE_MENU = [
    ("Rice and curry", "Chicken Rice & Curry", 750, "Red rice or white rice with chicken curry, dhal, 2 vegetables, papadam and sambol.", ("Portion", [("Regular", 750), ("Large", 1050)])),
    ("Rice and curry", "Fish Rice & Curry", 700, "Ambul thiyal style fish with dhal, 2 vegetables and papadam.", ("Portion", [("Regular", 700), ("Large", 980)])),
    ("Rice and curry", "Vegetable Rice & Curry", 550, "5 vegetable curries, dhal and papadam.", ("Portion", [("Regular", 550), ("Large", 780)])),
    ("Rice and curry", "Lamprais (Dutch Burgher)", 1650, "Banana leaf baked rice with mixed meat, frikkadels, blachan and egg.", None),
    ("Kottu", "Chicken Kottu", 1250, "Godamba kottu with chicken, egg and curry gravy.", ("Portion", [("Regular", 1250), ("Large", 1650)])),
    ("Kottu", "Cheese Kottu", 1650, "Chicken cheese kottu with mozzarella.", ("Portion", [("Regular", 1650), ("Large", 2150)])),
    ("Kottu", "Seafood Kottu", 1850, "Prawns, cuttlefish and fish.", ("Portion", [("Regular", 1850), ("Large", 2450)])),
    ("Kottu", "Vegetable Kottu", 950, "Egg and vegetables. Ask for vegan (no egg).", ("Portion", [("Regular", 950), ("Large", 1300)])),
    ("Fried rice and noodles", "Mixed Fried Rice", 1550, "Chicken, prawns and egg with chilli paste on the side.", ("Portion", [("Regular", 1550), ("Large", 2050)])),
    ("Fried rice and noodles", "Nasi Goreng", 1750, "Spicy fried rice with fried egg, chicken drumstick and satay.", None),
    ("Fried rice and noodles", "Chicken Noodles", 1350, "Wok-fried egg noodles with chicken.", ("Portion", [("Regular", 1350), ("Large", 1800)])),
    ("Biriyani", "Chicken Biriyani", 1650, "Basmati biriyani with chicken, egg, raita and mint sambol.", ("Portion", [("Regular", 1650), ("Large", 2250)])),
    ("Biriyani", "Mutton Biriyani", 2450, "Slow-cooked mutton with basmati rice.", None),
    ("Devilled and sides", "Devilled Chicken", 1800, "Spicy devilled chicken with capsicum and onion.", ("Portion", [("Half", 1800), ("Full", 3200)])),
    ("Devilled and sides", "Hot Butter Cuttlefish", 2200, "Crispy cuttlefish tossed in butter and chilli.", None),
    ("Short eats", "Fish Patties (5 pcs)", 600, "Crispy patties with fish filling.", None),
    ("Short eats", "Chicken Rolls (5 pcs)", 750, "Crumbed Chinese rolls.", None),
    ("Desserts", "Watalappan", 450, "Kithul jaggery coconut pudding.", None),
    ("Desserts", "Chocolate Biscuit Pudding", 550, "Classic Sri Lankan biscuit pudding.", None),
    ("Cakes", "Ribbon Cake (1 kg)", 3900, "Order 1 day before.", None),
    ("Cakes", "Chocolate Fudge Cake (1 kg)", 5900, "Order 1 day before. Name written free.", None),
    ("Drinks", "Fresh Lime Juice", 450, "With or without sugar.", None),
    ("Drinks", "Faluda", 750, "Rose syrup, basil seeds, jelly and ice cream.", None),
    ("Drinks", "King Coconut", 350, "Chilled thambili.", None),
]

APEX = [
    ("Solar packages (on-grid)", "3 kW On-Grid Solar System", "Apex", 785000, "For monthly bills Rs 8,000-15,000. 6 x 550W panels, 3 kW inverter, mounting, wiring, CEB/LECO paperwork.", "Saves about 360 units a month; 10 years inverter warranty; 25 years panel performance warranty", None),
    ("Solar packages (on-grid)", "5 kW On-Grid Solar System", "Apex", 1150000, "For monthly bills Rs 15,000-30,000. 10 x 550W panels, 5 kW Huawei inverter, full installation.", "Saves about 600 units a month; payback about 3.5-4 years", None),
    ("Solar packages (on-grid)", "10 kW On-Grid Solar System", "Apex", 2150000, "For bills Rs 30,000-60,000 or 3-phase homes. 19 x 550W panels, 10 kW 3-phase inverter.", "Saves about 1,200 units a month", None),
    ("Solar packages (on-grid)", "20 kW Commercial Solar System", "Apex", 3950000, "For shops, offices and small factories. Price depends on roof and 3-phase supply.", "Site visit and engineering report free", None),
    ("Solar packages (hybrid)", "5 kW Hybrid Solar + 5 kWh Battery", "Apex", 1950000, "Solar with backup power during power cuts. 10 x 550W panels, 5 kW hybrid inverter, 5 kWh lithium battery.", "Runs lights, fans, fridge, TV and WiFi in a power cut", None),
    ("Solar packages (hybrid)", "8 kW Hybrid Solar + 10 kWh Battery", "Apex", 3250000, "For bigger homes with AC. 16 x 550W panels, 8 kW hybrid inverter, 10 kWh battery.", "Backup for most of the house", None),
    ("Inverters", "Huawei SUN2000 5 kW On-Grid Inverter", "Huawei", 285000, "Single phase, WiFi monitoring app.", "10 years warranty", None),
    ("Inverters", "Growatt 5 kW Hybrid Inverter", "Growatt", 365000, "Hybrid inverter for lithium batteries.", "5 years warranty (extendable)", None),
    ("Batteries", "Lithium LiFePO4 Battery 5 kWh", "Pylontech", 520000, "Wall or rack battery, 6,000 cycles.", "10 years warranty", None),
    ("Panels", "Jinko Tiger Neo 550W Panel", "Jinko", 38000, "N-type mono panel, tier-1 brand.", "30 years performance warranty", None),
    ("Solar water heaters", "Solar Water Heater 200L", "Apex", 245000, "Hot water for a family of 4-5, no electricity needed.", "5 years tank warranty", None),
]

# ───────────────────────── companies ─────────────────────────
COMPANIES = [
    dict(key="novagadgets", name="Nova Gadgets", cat="product", plan="growth", industry="Electronics", phone="0771110001", address="No. 22, Duplication Road, Colombo 3",
         catalog=[(c, n, b, p, kg, d, s, v) for c, n, b, p, kg, d, s, v in NOVA]),
    dict(key="brightpath", name="Bright Path Campus", cat="service", plan="growth", industry="Education", phone="0771110002", address="No. 140, High Level Road, Nugegoda", catalog=[]),
    dict(key="glowandgo", name="Glow & Go Beauty Studio", cat="both", plan="growth", industry="Beauty and health", phone="0771110003", address="No. 45, Galle Road, Wellawatte, Colombo 6",
         catalog=GLOW_PRODUCTS),
    dict(key="spiceroute", name="Spice Route Kitchen", cat="both", plan="growth", industry="Restaurant and takeaway", phone="0771110004", address="No. 88, Stanley Thilakaratne Mawatha, Nugegoda",
         catalog=[(c, n, None, p, 0.6, d, "", v) for c, n, p, d, v in SPICE_MENU]),
    dict(key="islandtrails", name="Island Trails Travel", cat="service", plan="growth", industry="Travel", phone="0771110005", address="No. 7, Peradeniya Road, Kandy", catalog=[]),
    dict(key="goldenvows", name="Golden Vows Weddings & Events", cat="service", plan="growth", industry="Events and wedding", phone="0771110006", address="No. 31, Negombo Road, Wattala", catalog=[]),
    dict(key="apexsolar", name="Apex Solar Energy", cat="both", plan="business", industry="Solar and energy", phone="0771110007", address="No. 210, Kandy Road, Kiribathgoda",
         catalog=[(c, n, b, p, None, d, s, v) for c, n, b, p, d, s, v in APEX]),
]

AGENT_METRA = dict(name="Agent Metra", email="agentmetra@gmail.com", phone="", address="Colombo, Sri Lanka", industry="Computers and IT", plan="pro")
SKU_VARIANT = {"Colour": "COL", "Strap": "STR", "Model": "MOD", "Portion": "POR", "Value": "VAL"}


def main():
    pw = scrypt_hash(PASSWORD)
    emails = []
    for c in COMPANIES:
        emails += [f"{c['key']}@demo.test", f"{c['key']}.agent@demo.test"]
    elist = ", ".join(q(e) for e in emails)

    out = []
    p = out.append
    p(f"""-- Agent Metra – the Agent Metra company account + 7 industry demo companies
-- generated by scripts/make-industry-demos.py. Password for every login: {PASSWORD}
-- Agent Metra:  agentmetra@gmail.com
-- Demo owners:  {', '.join(c['key'] + '@demo.test' for c in COMPANIES)}
-- Demo agents:  <key>.agent@demo.test
BEGIN;
SET search_path = public;

-- ───────── remove an earlier run of these demo companies (only these @demo.test logins) ─────────
CREATE TEMP TABLE _old ON COMMIT DROP AS SELECT DISTINCT company_id AS id FROM app_user WHERE email IN ({elist}) AND company_id IS NOT NULL;
DELETE FROM bot_message WHERE conversation_id IN (SELECT c.id FROM bot_conversation c JOIN bot_channel_user u ON u.id = c.bot_channel_user_id WHERE u.company_id IN (SELECT id FROM _old));
DELETE FROM lead_stage_event WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_ai_usage WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_notification WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_booking WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_order_item WHERE order_id IN (SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_order_status_history WHERE order_id IN (SELECT id FROM bot_order WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_order WHERE company_id IN (SELECT id FROM _old);
DELETE FROM bot_conversation WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id IN (SELECT id FROM _old));
DELETE FROM bot_customer_note WHERE company_id IN (SELECT id FROM _old);
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

    # ───────── Agent Metra (kept and updated if it exists) ─────────
    a = AGENT_METRA
    p(f"""
-- ───────── Agent Metra – our own account (sells Agent Metra on our WhatsApp) ─────────
DO $$
DECLARE cid BIGINT; uid INT; pkg INT; pcode TEXT; ind BIGINT;
BEGIN
  SELECT id, code INTO pkg, pcode FROM platform_package WHERE code = {q(a['plan'])} LIMIT 1;
  IF pkg IS NULL THEN SELECT id, code INTO pkg, pcode FROM platform_package WHERE is_active ORDER BY sort_order DESC LIMIT 1; END IF;
  SELECT id INTO ind FROM industry WHERE LOWER(name) = LOWER({q(a['industry'])}) LIMIT 1;
  IF ind IS NULL THEN INSERT INTO industry (name, is_active) VALUES ({q(a['industry'])}, TRUE) RETURNING id INTO ind; END IF;

  SELECT id, company_id INTO uid, cid FROM app_user WHERE LOWER(email) = LOWER({q(a['email'])}) LIMIT 1;
  IF cid IS NULL THEN
    INSERT INTO companies (company_name, status, plan, email, phone, address, business_category, industry_id, bot_enabled)
      VALUES ({q(a['name'])}, 'ACTIVE', pcode, {q(a['email'])}, {q(a['phone'])}, {q(a['address'])}, 'service', ind, TRUE) RETURNING id INTO cid;
  ELSE
    UPDATE companies SET company_name = {q(a['name'])}, status = 'ACTIVE', plan = pcode, email = {q(a['email'])}, business_category = 'service',
      industry_id = ind, bot_enabled = TRUE, updated_at = NOW() WHERE id = cid;
  END IF;
  IF uid IS NULL THEN
    INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, team_role, is_agent_active)
      VALUES ('Agent Metra', {q(a['email'])}, {q(pw)}, TRUE, cid, NOW(), 'owner', TRUE) RETURNING id INTO uid;
  ELSE
    UPDATE app_user SET password_hash = {q(pw)}, is_active = TRUE, company_id = cid, team_role = 'owner', email_verified_at = COALESCE(email_verified_at, NOW()),
      access_disabled = FALSE, failed_login_count = 0, locked_until = NULL, token_version = token_version + 1, updated_at = NOW() WHERE id = uid;
  END IF;
  UPDATE companies SET admin_user_id = uid WHERE id = cid;
  DELETE FROM company_subscription WHERE company_id = cid;
  INSERT INTO company_subscription (company_id, package_id, billing_cycle, status, period_start, period_end, token_period_start, token_period_end, auto_renew)
    VALUES (cid, pkg, 'yearly', 'active', NOW(), NOW() + INTERVAL '365 days', NOW(), NOW() + INTERVAL '30 days', TRUE);
  RAISE NOTICE 'Agent Metra company % ready (login {a['email']})', cid;
END $$;
""")

    for n, c in enumerate(COMPANIES):
        key = c["key"]
        cats = sorted({row[0] for row in c["catalog"]})
        p(f"\n-- ───────── {c['name']} ({c['cat']}, {len(c['catalog'])} products) ─────────")
        p(f"""DO $$
DECLARE
  cid BIGINT; uid INT; aid INT; pkg INT; pcode TEXT; ind BIGINT; cat_ids JSONB := '{{}}'::jsonb; cat_id INT; pid INT;
BEGIN
  SELECT id, code INTO pkg, pcode FROM platform_package WHERE code = {q(c['plan'])} LIMIT 1;
  IF pkg IS NULL THEN SELECT id, code INTO pkg, pcode FROM platform_package WHERE is_active ORDER BY sort_order DESC LIMIT 1; END IF;
  SELECT id INTO ind FROM industry WHERE LOWER(name) = LOWER({q(c['industry'])}) LIMIT 1;
  IF ind IS NULL THEN INSERT INTO industry (name, is_active) VALUES ({q(c['industry'])}, TRUE) RETURNING id INTO ind; END IF;
  INSERT INTO companies (company_name, status, plan, email, phone, address, business_category, industry_id, bot_enabled)
    VALUES ({q(c['name'])}, 'ACTIVE', pcode, {q(key + '@demo.test')}, {q(c['phone'])}, {q(c['address'])}, {q(c['cat'])}, ind, TRUE) RETURNING id INTO cid;
  INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, whatsapp_number, whatsapp_verified_at, team_role, is_agent_active)
    VALUES ({q(c['name'] + ' Owner')}, {q(key + '@demo.test')}, {q(pw)}, TRUE, cid, NOW(), {q('94' + c['phone'][1:])}, NOW(), 'owner', TRUE) RETURNING id INTO uid;
  INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, team_role, is_agent_active)
    VALUES ({q(c['name'] + ' Agent')}, {q(key + '.agent@demo.test')}, {q(pw)}, TRUE, cid, NOW(), 'agent', TRUE) RETURNING id INTO aid;
  UPDATE companies SET admin_user_id = uid WHERE id = cid;
  INSERT INTO company_subscription (company_id, package_id, billing_cycle, status, period_start, period_end, token_period_start, token_period_end, auto_renew)
    VALUES (cid, pkg, 'yearly', 'active', NOW(), NOW() + INTERVAL '365 days', NOW(), NOW() + INTERVAL '30 days', FALSE);""")
        for cat in cats:
            p(f"  INSERT INTO product_catergory (name, company_id, is_active) VALUES ({q(cat)}, cid, TRUE) RETURNING id INTO cat_id; cat_ids := cat_ids || jsonb_build_object({q(cat)}, cat_id);")
        for i, (cat, name, brand, price, kg, desc, points, variants) in enumerate(c["catalog"]):
            sku = f"{key[:4].upper()}-{i + 1:03d}"
            p(f"  INSERT INTO product (name, brand, description, sku, price, quantity, status, category_id, company_id, created_by, has_variants, weight, selling_points, is_available, show_to_bot) "
              f"VALUES ({q(name)}, {q(brand)}, {q(desc)}, {q(sku)}, {price}, {rnd.randint(4, 40)}, 'In Stock', (cat_ids->>{q(cat)})::int, cid, uid, "
              f"{q(bool(variants))}, {q(kg)}, {q(points)}, TRUE, TRUE) RETURNING id INTO pid;")
            if variants:
                vname, values = variants
                vs = [{"sku": f"{sku}-{SKU_VARIANT.get(vname, 'VAR')}{j + 1}", "price": pr, "quantity": rnd.randint(2, 25), "available": True,
                       "variant_name": vname, "variant_value": v} for j, (v, pr) in enumerate(values)]
                p(f"  INSERT INTO product_variant (product_id, variants) VALUES (pid, {q(json.dumps(vs, ensure_ascii=False))}::jsonb);")
        p(f"  RAISE NOTICE '{c['name']}: company %', cid;\nEND $$;")

    p("\nCOMMIT;")
    print("\n".join(out))


if __name__ == "__main__":
    main()
