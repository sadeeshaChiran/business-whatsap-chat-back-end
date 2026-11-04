#!/usr/bin/env python3
"""Makes showcase-demo.sql: a full demo shop for videos and sales demos – products AND services, with data in every screen.

Run:  python3 scripts/make-showcase-demo.py > showcase-demo.sql
      DEMO_EMAIL=you@example.com python3 scripts/make-showcase-demo.py > showcase-demo.sql
Load: Supabase SQL editor (paste and run), or psql -v ON_ERROR_STOP=1 -f showcase-demo.sql

Only the company whose ADMIN logs in with DEMO_EMAIL is changed. Running it again first removes the demo rows it made
(products SKU DEMO-…, demo customers 9479999…/demo-…, and the named demo flows, forms, links, notes and templates),
so real chats, products and orders of that company are never touched.
Demo customers have fake numbers – never send a broadcast to the tag "demo".
"""
import hashlib
import json
import os
import random

EMAIL = os.environ.get("DEMO_EMAIL", "demo@agentmetra.lk")
# when set, the account is CREATED if it does not exist yet (Business package, email already verified)
PASSWORD = os.environ.get("DEMO_PASSWORD", "")


def scrypt_hash(password: str) -> str:
    """Same as AuthService: scrypt(password, salt-hex, 64) -> "salt:hash"."""
    salt = os.urandom(16).hex()
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return f"{salt}:{key.hex()}"
SHOP = "Nimal Fashion & Beauty"
rnd = random.Random(2026)


def q(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def j(value) -> str:
    return q(json.dumps(value, ensure_ascii=False)) + "::jsonb"


# ---------- catalogue ----------
# (category, name, brand, price, kg, variants [(name, value, price)], description, selling points)
PRODUCTS = [
    ("Women's dresses", "Floral Maxi Dress", "Nimal", 4950, 0.4, [("Size", "S", 4950), ("Size", "M", 4950), ("Size", "L", 4950), ("Size", "XL", 5250)],
     "Soft rayon maxi dress with a floral print, side pockets and a tie belt.", "Light for hot days · machine washable · true to size"),
    ("Women's dresses", "Blue Linen Frock", "Nimal", 3450, 0.35, [("Size", "S", 3450), ("Size", "M", 3450), ("Size", "L", 3450)],
     "Short-sleeve linen frock in sky blue, knee length.", "Breathable linen · office or casual"),
    ("Women's dresses", "Office Wrap Dress", "Nimal", 5450, 0.4, [("Colour", "Black", 5450), ("Colour", "Maroon", 5450), ("Colour", "Navy", 5450)],
     "Wrap dress with a V-neck and 3/4 sleeves, stretch crepe.", "No ironing · fits S–L (adjustable wrap)"),
    ("Ethnic wear", "Bathik Saree (Hand-made)", "Lanka Bathik", 12500, 0.7, None,
     "Hand-made cotton bathik saree with blouse piece, 6 yards.", "Made in Sri Lanka · gift box"),
    ("Ethnic wear", "Kurta Top", "Nimal", 2950, 0.3, [("Size", "M", 2950), ("Size", "L", 2950), ("Size", "XL", 2950)],
     "Cotton kurta top with embroidered neck.", "Pairs with jeans or leggings"),
    ("Men's wear", "Oxford Shirt (Long Sleeve)", "Nimal Men", 3250, 0.3, [("Size", "M", 3250), ("Size", "L", 3250), ("Size", "XL", 3250), ("Size", "XXL", 3450)],
     "100% cotton Oxford shirt in white, blue and pink.", "Office ready · button-down collar"),
    ("Men's wear", "Slim Fit Chinos", "Nimal Men", 3950, 0.5, [("Waist", "30", 3950), ("Waist", "32", 3950), ("Waist", "34", 3950), ("Waist", "36", 3950)],
     "Stretch cotton chinos in khaki and navy.", "Free hemming in store"),
    ("Men's wear", "Batik Sarong", "Lanka Bathik", 2450, 0.35, None, "Cotton batik sarong, ready-stitched.", "Gift favourite"),
    ("Kids", "Kids Party Frock", "Little Nimal", 2850, 0.3, [("Age", "2-3 yrs", 2850), ("Age", "4-5 yrs", 2850), ("Age", "6-7 yrs", 2950)],
     "Tulle party frock with a satin bow.", "Soft lining · no itching"),
    ("Kids", "Boys T-Shirt Pack (3)", "Little Nimal", 2250, 0.4, [("Age", "4-5 yrs", 2250), ("Age", "6-7 yrs", 2250), ("Age", "8-9 yrs", 2250)],
     "3 cotton t-shirts: grey, navy, red.", "Value pack"),
    ("Beauty", "Herbal Face Wash 100ml", "Nature's Secrets", 690, 0.15, None, "Neem and aloe face wash for oily skin.", "Paraben free"),
    ("Beauty", "Vitamin C Serum 30ml", "Glow Lab", 2450, 0.1, None, "10% vitamin C serum for even skin tone.", "Use at night · patch test first"),
    ("Beauty", "Matte Lipstick", "Glow Lab", 1250, 0.05, [("Shade", "Rose Nude", 1250), ("Shade", "Brick Red", 1250), ("Shade", "Berry", 1250)],
     "Long-lasting matte lipstick, 8 hours.", "Transfer proof"),
    ("Beauty", "Hair Oil (Kesharaja) 200ml", "Siddhalepa", 850, 0.25, None, "Ayurvedic hair oil for hair fall.", "Herbal · warm before use"),
    ("Accessories", "Leather Handbag", "Nimal", 6950, 0.8, [("Colour", "Tan", 6950), ("Colour", "Black", 6950)], "Genuine leather tote with a zip pocket.", "1-year stitching warranty"),
    ("Accessories", "Silver Plated Earrings", "Nimal", 1450, 0.05, None, "Hypoallergenic silver plated drop earrings.", "Gift box included"),
]
OUT_OF_STOCK = {"Office Wrap Dress": ["Navy"]}

# (name, description, price, price_note, minutes)
SERVICES = [
    ("Hair Cut & Style", "Wash, cut and blow-dry by a senior stylist.", 2500, "from", 60),
    ("Bridal Dressing", "Full bridal dressing, hair, saree draping and make-up. Trial included.", 45000, "from", 240),
    ("Party Make-up", "Make-up and hair for parties and functions.", 6500, "", 90),
    ("Facial (Herbal)", "60-minute herbal facial with face massage.", 4500, "", 60),
    ("Saree Draping", "Saree draping at the salon.", 1500, "", 30),
    ("Dress Alteration", "Hemming, fitting and small changes on clothes bought from us (free for chinos hemming).", 800, "from", 30),
]

# (area, fee, days, included kg, per extra kg)
ZONES = [("Colombo", 350, "1-2 days", 1, 100), ("Gampaha", 400, "2-3 days", 1, 100), ("Kandy", 450, "2-3 days", 1, 120),
         ("Kurunegala", 450, "2-3 days", 1, 120), ("Galle", 450, "2-3 days", 1, 120), ("*", 500, "2-4 days", 1, 150)]

KNOWLEDGE = [
    ("Payment", "How can I pay?", "Cash on delivery, bank transfer (send the slip) or card at the shop. Koko instalments for orders over Rs 5,000."),
    ("Delivery", "How long does delivery take?", "Colombo 1-2 days, other areas 2-4 days. Free delivery for orders over Rs 10,000."),
    ("Returns", "Can I exchange a size?", "Yes – size exchange within 7 days with the bill, unworn and with tags. Sale items cannot be exchanged."),
    ("Shop", "Where is the shop?", "No. 25, Main Street, Kurunegala. Open every day 9 am - 8 pm. Parking behind the shop."),
    ("Salon", "Do I need to book the salon?", "Yes, please book – walk-ins only if a stylist is free. Bridal dressing needs a 50% advance."),
    ("Salon", "Bridal package details?", "Bridal dressing from Rs 45,000: trial, hair, make-up, saree or gown dressing and 2 bridesmaids at Rs 6,500 each."),
    ("Sizes", "What is your size chart?", "S fits bust 32-34, M 34-36, L 36-38, XL 38-40 inches. Ask us for a dress's exact length."),
    ("Wholesale", "Do you sell wholesale?", "Yes, 10+ pieces of one design get 15% off. Send the design and quantity – our team will reply with a quote."),
    ("Gifts", "Do you have gift wrapping?", "Free gift wrapping with a card – just tell us the message."),
    ("Care", "How should I wash linen?", "Hand wash or gentle cycle in cold water, dry in shade, iron while a little damp."),
]

LABELS = [("VIP", "#7C3AED"), ("Wholesale", "#0EA5E9"), ("Repeat buyer", "#10B981"), ("Bridal", "#EC4899"), ("Follow up", "#F59E0B"), ("demo", "#94A3B8")]

# customers: (key, name, platform, external id, phone, language, stage, tags, deal, source, open chat?)
CUSTOMERS = [
    ("kumari", "Kumari Perera", "whatsapp", "94799999001", "94799999001", "si", "won", ["VIP", "Repeat buyer"], 18400, "whatsapp", False),
    ("nuwan", "Nuwan Jayasinghe", "whatsapp", "94799999002", "94799999002", "si", "qualified", ["Follow up"], 7900, "ad", True),
    ("priya", "Priya Raj", "whatsapp", "94799999003", "94799999003", "ta", "won", ["Repeat buyer"], 9450, "whatsapp", False),
    ("dilini", "Dilini Fernando", "instagram", "demo-ig-dilini", "94799999004", "en", "proposal", ["Bridal", "VIP"], 45000, "instagram", True),
    ("ashan", "Ashan Silva", "messenger", "demo-msg-ashan", "94799999005", "si", "contacted", [], 3950, "messenger", False),
    ("sachini", "Sachini Wickramasinghe", "whatsapp", "94799999006", "94799999006", "si", "won", ["VIP"], 12500, "link", False),
    ("rizwan", "Mohamed Rizwan", "whatsapp", "94799999007", "94799999007", "en", "qualified", ["Wholesale"], 63000, "whatsapp", True),
    ("tharushi", "Tharushi Gunawardena", "instagram", "demo-ig-tharushi", "94799999008", "si", "new", [], 0, "instagram", False),
    ("kavin", "Kavin Sivakumar", "messenger", "demo-msg-kavin", "94799999009", "ta", "lost", [], 2450, "messenger", False),
    ("malsha", "Malsha Rathnayake", "whatsapp", "94799999010", "94799999010", "si", "won", ["Repeat buyer"], 6500, "whatsapp", False),
    ("james", "James Anderson", "whatsapp", "94799999011", "94799999011", "en", "contacted", [], 12500, "ad", False),
    ("nadeesha", "Nadeesha Herath", "whatsapp", "94799999012", "94799999012", "si", "new", ["Follow up"], 0, "whatsapp", False),
]

# team: (key, name, login email, role) – 4 agents and 1 supervisor, same password as the demo owner
TEAM = [("kasun", "Kasun Perera", "kasun.demo@agentmetra.lk", "agent"),
        ("sandali", "Sandali Fernando", "sandali.demo@agentmetra.lk", "agent"),
        ("sanjeewa", "Sanjeewa Silva", "sanjeewa.demo@agentmetra.lk", "agent"),
        ("ishara", "Ishara Rajendran", "ishara.demo@agentmetra.lk", "agent"),
        ("chamari", "Chamari Wijesinghe", "chamari.demo@agentmetra.lk", "supervisor")]
# who each chat went to, the way chat routing gives them: a returning buyer goes back to the same agent (sticky),
# new chats go round-robin; Tamil chats to Ishara. None = still waiting in the chat queue.
ASSIGN = {"kumari": ("kasun", "sticky"), "nuwan": (None, "unassigned"), "priya": ("ishara", "sticky"), "dilini": ("sandali", "round_robin"),
          "ashan": ("kasun", "round_robin"), "sachini": ("sandali", "round_robin"), "rizwan": ("sanjeewa", "round_robin"),
          "tharushi": ("ishara", "round_robin"), "kavin": ("ishara", "round_robin"), "malsha": ("sandali", "sticky"),
          "james": ("sanjeewa", "round_robin"), "nadeesha": ("kasun", "round_robin")}
ACTIVE = {"dilini", "rizwan", "tharushi", "nadeesha"}  # open chats an agent is answering now

# chats: key -> [(direction, text, minutes before now)]  (in = customer, ai = bot, agent = team)
CHATS = {
    "kumari": [("in", "Hi! Floral maxi dress eka M size thiyenawada?", 2900), ("ai", "Ow Kumari, Floral Maxi Dress eka M size thiyenawa 😊 Mila Rs 4,950. Colombo walata delivery Rs 350, dawas 1-2kin enawa. Order karannada?", 2899),
               ("in", "ow karanna. address eka No 12, Nawala Road, Rajagiriya", 2890), ("ai", "Order summary:\n• Floral Maxi Dress (M) × 1 – Rs 4,950\n• Delivery (Colombo) – Rs 350\nTotal: Rs 5,300 · Cash on delivery\nConfirm karannada?", 2889),
               ("in", "confirm", 2888), ("ai", "Thank you! 🎉 Order eka confirm una. Heta ho anidda enawa.", 2887)],
    "nuwan": [("in", "Oxford shirt eke L size white ekai blue ekai thiyenawada", 95), ("ai", "Ow Nuwan, Oxford Shirt eka L size white saha blue dekama thiyenawa. Ekak Rs 3,250. Deka gaththoth Rs 6,500 + delivery.", 94),
              ("in", "Kandy walata delivery kiyada", 60), ("ai", "Kandy walata Rs 450 (1 kg wenakam), dawas 2-3. Shirts deka 0.6 kg nisa Rs 450 i. Total Rs 6,950.", 59), ("in", "hari mama hawasata confirm karannam", 58)],
    "priya": [("in", "வணக்கம், kids party frock 4-5 வயது இருக்கா?", 7300), ("ai", "வணக்கம் Priya! ஆம், Kids Party Frock 4-5 வயது size இருக்கு. விலை Rs 2,850. Delivery Rs 450.", 7299),
              ("in", "சரி 2 வேணும்", 7290), ("ai", "2 frocks – Rs 5,700 + Delivery Rs 450 = Rs 6,150. Cash on delivery. உறுதி செய்யவா?", 7289), ("in", "ஆம்", 7288)],
    "dilini": [("in", "Hi, I'm getting married on 14 December. Can I know the bridal package?", 300), ("ai", "Congratulations Dilini! 💐 Our bridal dressing starts from Rs 45,000 – includes a trial, hair, make-up and saree or gown dressing. Bridesmaids Rs 6,500 each. Shall I book a trial?", 299),
               ("in", "Yes please, trial on Saturday morning?", 290), ("ai", "Saturday 10:00 is free for a 4-hour trial. I've sent your request to our team – they'll confirm shortly.", 289), ("agent", "Hi Dilini, this is Sandali from Nimal Beauty. Your trial is confirmed for Saturday 10 am 😊", 240)],
    "ashan": [("in", "chinos 32 waist navy thiyenawada", 4400), ("ai", "Ow Ashan, Slim Fit Chinos 32 waist navy thiyenawa – Rs 3,950. Shop eke free hemming karanawa.", 4399), ("in", "ok thanks passe kiyannam", 4390)],
    "sachini": [("in", "Bathik saree eka photo ekak ewanna puluwanda", 10100), ("ai", "Ow! Me thiyenne Bathik Saree (Hand-made) eka – Rs 12,500, blouse piece ekath ekka. Gift box ekak free.", 10099),
                ("in", "order karanna. Galle", 10080), ("ai", "Galle walata delivery Rs 450. Total Rs 12,950. Bank transfer da cash on delivery da?", 10079), ("in", "bank transfer. slip eka ewannam", 10070)],
    "rizwan": [("in", "Hello, I run a boutique in Kandy. Can I get 20 pcs of the floral maxi dress wholesale?", 180), ("ai", "Hi Rizwan! For 10+ pieces of one design we give 15% off. 20 × Rs 4,950 = Rs 99,000 → Rs 84,150 after discount. I'll pass this to our team for a formal quote.", 179),
               ("agent", "Hi Rizwan, Sanjeewa here. We can do sizes S-XL mixed. Sending the quote now.", 120), ("in", "Great, please include delivery to Kandy", 115)],
    "tharushi": [("in", "lipstick shades monada thiyenne", 20), ("ai", "Matte Lipstick shades 3k thiyenawa: Rose Nude, Brick Red, Berry. Ekak Rs 1,250 💄", 19)],
    "kavin": [("in", "sarong price?", 14000), ("ai", "Batik Sarong – Rs 2,450, ready-stitched.", 13999), ("in", "too much", 13990)],
    "malsha": [("in", "Facial ekak book karanna puluwanda heta", 1500), ("ai", "Ow Malsha, heta Herbal Facial (Rs 4,500, peya 1) walata 11:00 ho 15:00 free. Mona welawa hodada?", 1499), ("in", "11", 1490), ("ai", "Hari! Heta 11:00 ta Herbal Facial book kala ✅", 1489)],
    "james": [("in", "Do you deliver to Negombo? Want the leather handbag in tan", 900), ("ai", "Yes James! Negombo is in Gampaha – delivery Rs 400, 2-3 days. Leather Handbag (Tan) is Rs 6,950.", 899)],
    "nadeesha": [("in", "Hair cut ekak kiyada", 45), ("ai", "Hair Cut & Style Rs 2,500 idan – wash, cut and blow-dry. Book karannada?", 44)],
}

# orders: (customer, status, days ago, [(product, variant text, qty)], area, payment)
ORDERS = [
    ("kumari", "Delivered", 2, [("Floral Maxi Dress", "Size: M", 1)], "Colombo", "Cash on delivery"),
    ("kumari", "Delivered", 21, [("Leather Handbag", "Colour: Tan", 1), ("Silver Plated Earrings", None, 2)], "Colombo", "Bank transfer"),
    ("priya", "Shipped", 5, [("Kids Party Frock", "Age: 4-5 yrs", 2)], "Kandy", "Cash on delivery"),
    ("sachini", "Processing", 7, [("Bathik Saree (Hand-made)", None, 1)], "Galle", "Bank transfer"),
    ("malsha", "Delivered", 12, [("Vitamin C Serum 30ml", None, 1), ("Herbal Face Wash 100ml", None, 2)], "Kurunegala", "Cash on delivery"),
    ("nuwan", "Pending", 0, [("Oxford Shirt (Long Sleeve)", "Size: L", 2)], "Kandy", "Cash on delivery"),
    ("james", "Confirmed", 1, [("Leather Handbag", "Colour: Tan", 1)], "Gampaha", "Card"),
    ("ashan", "Cancelled", 3, [("Slim Fit Chinos", "Waist: 32", 1)], "Colombo", "Cash on delivery"),
    ("rizwan", "Confirmed", 0, [("Floral Maxi Dress", "Size: M", 10), ("Floral Maxi Dress", "Size: L", 10)], "Kandy", "Bank transfer"),
    ("malsha", "Delivered", 26, [("Matte Lipstick", "Shade: Berry", 2), ("Hair Oil (Kesharaja) 200ml", None, 1)], "Kurunegala", "Cash on delivery"),
]
FLOW = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered"]

# bookings: (customer, service, day offset, time, status, note)
BOOKINGS = [
    ("dilini", "Bridal Dressing", 3, "10:00", "confirmed", "Trial – saree, wedding on 14 Dec"),
    ("malsha", "Facial (Herbal)", 1, "11:00", "confirmed", ""),
    ("nadeesha", "Hair Cut & Style", 2, "16:00", "requested", "Wants layers"),
    ("kumari", "Party Make-up", 6, "14:00", "requested", "Office party"),
    ("sachini", "Saree Draping", -4, "09:30", "done", ""),
    ("priya", "Hair Cut & Style", -9, "15:00", "done", ""),
    ("tharushi", "Party Make-up", -2, "17:00", "cancelled", "Changed date"),
    ("ashan", "Dress Alteration", 0, "12:30", "confirmed", "Chinos hemming"),
]

NOTES_FOR_CUSTOMERS = [
    ("kumari", "VIP – always buys size M. Likes floral prints. Send new arrivals first."),
    ("dilini", "Wedding 14 Dec, Hilton Colombo. 3 bridesmaids. Advance Rs 22,500 paid."),
    ("rizwan", "Boutique owner in Kandy – wholesale quote sent, follow up Friday."),
    ("nuwan", "Asked for Kandy delivery, will confirm in the evening."),
    ("sachini", "Bank slip received for the saree order."),
    ("malsha", "Prefers morning slots for salon."),
]
TASKS = [
    ("rizwan", "Call Rizwan about the wholesale quote", 1, "high", "call"),
    ("nuwan", "Remind Nuwan to confirm the shirts order", 0, "normal", "follow_up"),
    ("dilini", "Send Dilini the bridal trial photos", 4, "normal", "follow_up"),
    ("james", "Check handbag stock for James", -1, "low", "task"),
    ("nadeesha", "Confirm Nadeesha's hair cut booking", 1, "normal", "follow_up"),
]

SHOP_NOTES = [  # (colour tag, title, content, for AI)
    ("Important", "December sale", "From 1 Dec all dresses 20% off. Bridal packages not included.", True),
    ("Important", "Bridal advance", "Bridal bookings need a 50% advance by bank transfer before the trial.", True),
    ("Info", "Shop closed on Poya", "Salon closed on Poya days; the online shop still takes orders.", True),
    ("Info", "Courier", "Orders packed by 4 pm go out the same day with Domex.", False),
]

TEMPLATES = [
    ("Bank details", "Bank details", "Bank: Commercial Bank · Account: Nimal Fashion · No: 1234 5678 90 · Branch: Kurunegala. Please send the slip after paying 😊"),
    ("Size chart", "Size chart", "S: bust 32-34 · M: 34-36 · L: 36-38 · XL: 38-40 inches. Tell me your size and I'll check stock!"),
    ("Thank you", "Thank you", "Thank you for shopping with Nimal Fashion & Beauty 💜 See you again!"),
]
SAVED_REPLIES = [
    ("reply", "Price in inbox", "Thanks! We sent you the price and sizes in your inbox 😊"),
    ("reply", "Out of stock", "Sorry, this one is sold out – new stock next week. We'll message you!"),
    ("dm", "Comment to DM", "Hi! Thanks for your comment 💜 Here are the details you asked for:"),
    ("hashtags", "Fashion tags", "#NimalFashion #SriLankaFashion #OnlineShoppingLK #BathikSaree #Kurunegala"),
]

FORMS = [
    ("booking", "Salon booking request", "Book the salon", "Tell us when you'd like to come – we'll confirm on WhatsApp.",
     [{"id": "f1", "label": "Your name", "type": "text", "required": True, "maps_to": "name"},
      {"id": "f2", "label": "Service", "type": "choice", "required": True, "options": ["Hair Cut & Style", "Facial", "Party Make-up", "Bridal Dressing"]},
      {"id": "f3", "label": "Date", "type": "date", "required": True},
      {"id": "f4", "label": "Phone", "type": "phone", "required": True, "maps_to": "phone"}],
     "Thank you! We'll confirm your time shortly 💜", ["salon"], "qualified"),
    ("wholesale", "Wholesale inquiry", "Wholesale price request", "10+ pieces of one design get 15% off.",
     [{"id": "f1", "label": "Shop / business name", "type": "text", "required": True},
      {"id": "f2", "label": "Products and quantity", "type": "long_text", "required": True},
      {"id": "f3", "label": "Delivery address", "type": "address", "required": False, "maps_to": "address"},
      {"id": "f4", "label": "Email", "type": "email", "required": False, "maps_to": "email"}],
     "Thanks! Our team will send a quote within a day.", ["Wholesale"], "proposal"),
]


def flows(form_ref):
    return [
        ("Welcome new customers", "Greets a first-time customer with a menu.", "paused", "first_message", {"once_per_contact": True},
         [{"id": "s1", "type": "text", "text": "Hi {{name}} 👋 Welcome to Nimal Fashion & Beauty!"},
          {"id": "s2", "type": "buttons", "text": "What are you looking for today?", "save_as": "interest",
           "buttons": [{"label": "Shop clothes", "goto": 2, "tag": "shopper"}, {"label": "Book salon", "goto": 3, "tag": "salon"}, {"label": "Talk to us", "goto": 4, "tag": ""}]},
          {"id": "s3", "type": "handoff", "to": "ai", "text": "Great! Tell me the item or send a photo 😊"},
          {"id": "s4", "type": "form", "form_id": form_ref, "form_mode": "chat", "text": "Let's book you in:"},
          {"id": "s5", "type": "handoff", "to": "human", "text": "Our team will reply shortly."}]),
        ("Wholesale keyword", "When a message says wholesale, tag and hand to the team.", "paused", "keyword", {"keywords": ["wholesale", "bulk"], "match": "contains", "once_per_contact": False},
         [{"id": "s1", "type": "tag", "tags": ["wholesale"]}, {"id": "s2", "type": "stage", "stage": "qualified"},
          {"id": "s3", "type": "handoff", "to": "human", "text": "Thanks! Our wholesale team will send you a quote."}]),
        ("Comment 'price' → DM", "Replies to price comments on Facebook / Instagram posts and sends a DM.", "paused", "comment",
         {"keywords": ["price", "kiyada", "how much"], "match": "contains", "comment_reply": "Sent you the price in your inbox 💜", "comment_platforms": ["facebook", "instagram"], "once_per_contact": True},
         [{"id": "s1", "type": "text", "text": "Hi {{name}}! Thanks for your comment 💜 Tell me your size and area – I'll share the price and delivery."},
          {"id": "s2", "type": "handoff", "to": "ai", "text": ""}]),
    ]


def agent_id(key, fallback="uid"):
    who = ASSIGN.get(key, (None, ""))[0]
    return f"(ags->>{q(who)})::bigint" if who else fallback


def agent_name(key):
    who = ASSIGN.get(key, (None, ""))[0]
    return next((t[1] for t in TEAM if t[0] == who), "Shop team")


def main():
    cats = sorted({p[0] for p in PRODUCTS})
    names = [p[1] for p in PRODUCTS]
    cust_keys = [c[0] for c in CUSTOMERS]
    out = []
    w = out.append
    create = ""
    if PASSWORD:
        create = f"""  -- ===== the demo login (made only if it does not exist yet) =====
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE LOWER(email) = LOWER(demo_email)) THEN
    INSERT INTO companies (company_name, status, plan, email, phone, address, business_category, bot_enabled)
      VALUES ({q(SHOP)}, 'ACTIVE', 'business', demo_email, '0718191000', 'No. 25, Main Street, Kurunegala', 'both', TRUE) RETURNING id INTO cid;
    INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, team_role)
      VALUES ('Nimal (Demo owner)', demo_email, {q(scrypt_hash(PASSWORD))}, TRUE, cid, NOW(), 'owner') RETURNING id INTO uid;
    UPDATE companies SET admin_user_id = uid WHERE id = cid;
    INSERT INTO company_subscription (company_id, package_id, billing_cycle, status, period_start, period_end, token_period_start, token_period_end, auto_renew)
      SELECT cid, p.id, 'monthly', 'active', NOW(), NOW() + INTERVAL '365 days', NOW(), NOW() + INTERVAL '30 days', FALSE FROM platform_package p WHERE p.code = 'business' LIMIT 1;
    cid := NULL; uid := NULL;
  END IF;
"""
    w(f"""-- Agent Metra – showcase demo data: "{SHOP}" (clothing shop + beauty salon) – scripts/make-showcase-demo.py
-- {len(PRODUCTS)} products, {len(SERVICES)} services, {len(ZONES)} delivery zones, {len(KNOWLEDGE)} FAQs, {len(CUSTOMERS)} customers with chats,
-- 4 agents + 1 supervisor (chats routed to them), {len(ORDERS)} orders, {len(BOOKINGS)} bookings, CRM stages + tasks + notes + tags, {len(FORMS)} forms, 3 flows (paused), a campaign, 2 short links,
-- shop notes, quick-reply templates, social saved replies, income and expenses.
-- CHANGE THE EMAIL BELOW to the admin login of your demo account, then run the whole file once (safe to run again).
-- Demo customers use fake numbers 9479999xxxx / demo-… – never broadcast to the tag "demo".
BEGIN;
SET search_path = public;
DO $$
DECLARE
  demo_email TEXT := {q(EMAIL)};
  cid BIGINT; uid BIGINT; ind BIGINT; cat_id INT; pid INT; sid INT; cu INT; conv INT; oid INT; fid INT; tag_imp INT; tag_info INT; lab BIGINT; aid BIGINT; ags JSONB := '{{}}'::jsonb;
  ecat INT; icat INT; camp INT;
  cats JSONB := '{{}}'::jsonb; prods JSONB := '{{}}'::jsonb; servs JSONB := '{{}}'::jsonb; cus JSONB := '{{}}'::jsonb; convs JSONB := '{{}}'::jsonb; labs JSONB := '{{}}'::jsonb;
BEGIN
{create}  SELECT u.company_id, u.id INTO cid, uid FROM app_user u WHERE LOWER(u.email) = LOWER(demo_email) AND u.company_id IS NOT NULL ORDER BY u.id LIMIT 1;
  IF cid IS NULL THEN RAISE EXCEPTION 'No account with the login %. Change demo_email at the top of this file.', demo_email; END IF;

  -- ===== clean an older copy of this demo (only rows this file made) =====
  DELETE FROM bot_order_status_history WHERE order_id IN (SELECT o.id FROM bot_order o JOIN bot_channel_user c ON c.id = o.bot_channel_user_id WHERE c.company_id = cid AND (c.external_user_id LIKE '9479999%' OR c.external_user_id LIKE 'demo-%'));
  DELETE FROM bot_order_item WHERE order_id IN (SELECT o.id FROM bot_order o JOIN bot_channel_user c ON c.id = o.bot_channel_user_id WHERE c.company_id = cid AND (c.external_user_id LIKE '9479999%' OR c.external_user_id LIKE 'demo-%'));
  DELETE FROM bot_order WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM bot_booking WHERE company_id = cid AND (bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%')) OR created_by = 'demo');
  DELETE FROM crm_task WHERE company_id = cid AND bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM bot_customer_note WHERE company_id = cid AND bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM bot_contact_tag WHERE company_id = cid AND channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM crm_contact WHERE company_id = cid AND bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM lead_stage_event WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM bot_message WHERE conversation_id IN (SELECT v.id FROM bot_conversation v JOIN bot_channel_user c ON c.id = v.bot_channel_user_id WHERE c.company_id = cid AND (c.external_user_id LIKE '9479999%' OR c.external_user_id LIKE 'demo-%'));
  DELETE FROM bot_conversation WHERE bot_channel_user_id IN (SELECT id FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%'));
  DELETE FROM bot_channel_user WHERE company_id = cid AND (external_user_id LIKE '9479999%' OR external_user_id LIKE 'demo-%');
  DELETE FROM product_variant WHERE product_id IN (SELECT id FROM product WHERE company_id = cid AND sku LIKE 'DEMO-%');
  DELETE FROM product WHERE company_id = cid AND sku LIKE 'DEMO-%';
  DELETE FROM bot_service WHERE company_id = cid AND name IN ({", ".join(q(s[0]) for s in SERVICES)});
  DELETE FROM bot_delivery_zone WHERE company_id = cid;
  DELETE FROM bot_training_data WHERE company_id = cid AND question IN ({", ".join(q(k[1]) for k in KNOWLEDGE)});
  DELETE FROM automation_flow WHERE company_id = cid AND name IN ({", ".join(q(f[0]) for f in flows(0))});
  DELETE FROM chat_form WHERE company_id = cid AND slug LIKE 'demo-%';
  DELETE FROM marketing_link WHERE company_id = cid AND slug LIKE 'demo%';
  DELETE FROM marketing_campaign WHERE company_id = cid AND name = 'December Sale 2026';
  DELETE FROM note WHERE company_id = cid AND title IN ({", ".join(q(n[1]) for n in SHOP_NOTES)});
  DELETE FROM bot_message_template WHERE company_id = cid AND name IN ({", ".join(q(t[0]) for t in TEMPLATES)});
  DELETE FROM social_saved_reply WHERE company_id = cid AND title IN ({", ".join(q(t[1]) for t in SAVED_REPLIES)});
  DELETE FROM expense WHERE company_id = cid AND sourse = 'demo';
  DELETE FROM income WHERE company_id = cid AND sourse = 'demo';

  -- ===== company and bot =====
  SELECT id INTO ind FROM industry WHERE LOWER(name) = 'fashion and clothing' LIMIT 1;
  IF ind IS NULL THEN INSERT INTO industry (name, is_active) VALUES ('Fashion and clothing', TRUE) RETURNING id INTO ind; END IF;
  UPDATE companies SET company_name = {q(SHOP)}, industry_id = ind, business_category = 'both', bot_enabled = TRUE,
    address = 'No. 25, Main Street, Kurunegala', updated_at = NOW() WHERE id = cid;
  INSERT INTO bot_sales_settings (company_id, bot_name, tone, default_language, greeting, about, opening_hours, payment_methods, auto_enable_new_customers, sells, free_delivery_over, booking_capacity, booking_block_status)
  VALUES (cid, 'Nimali', 'friendly, warm, short – like a helpful shop assistant', 'auto',
    'Hi 👋 Welcome to Nimal Fashion & Beauty! Looking for clothes, or a salon booking? 😊',
    'Nimal Fashion & Beauty, Kurunegala: women''s, men''s and kids clothing, bathik and beauty products with island-wide delivery, plus a beauty salon (hair, facials, party make-up and bridal dressing).',
    'Every day 9 am - 8 pm', 'Cash on delivery, bank transfer, card at the shop, Koko', TRUE, 'both', 10000, 2, 'requested')
  ON CONFLICT (company_id) DO UPDATE SET bot_name = EXCLUDED.bot_name, tone = EXCLUDED.tone, greeting = EXCLUDED.greeting, about = EXCLUDED.about,
    opening_hours = EXCLUDED.opening_hours, payment_methods = EXCLUDED.payment_methods, sells = EXCLUDED.sells, free_delivery_over = EXCLUDED.free_delivery_over,
    booking_capacity = EXCLUDED.booking_capacity, booking_block_status = EXCLUDED.booking_block_status, updated_at = NOW();
""")
    w("  -- ===== team: 4 agents + 1 supervisor (made once, kept on later runs) =====")
    team_hash = scrypt_hash(PASSWORD) if PASSWORD else scrypt_hash(os.urandom(12).hex())
    for key, name, email, role in TEAM:
        w(f"  SELECT id INTO aid FROM app_user WHERE LOWER(email) = LOWER({q(email)}) LIMIT 1;")
        w(f"  IF aid IS NULL THEN INSERT INTO app_user (name, email, password_hash, is_active, company_id, email_verified_at, team_role, is_agent_active) "
          f"VALUES ({q(name)}, {q(email)}, {q(team_hash)}, TRUE, cid, NOW(), {q(role)}, TRUE) RETURNING id INTO aid;")
        w(f"  ELSE UPDATE app_user SET company_id = cid, team_role = {q(role)}, is_active = TRUE, is_agent_active = TRUE WHERE id = aid; END IF;")
        w(f"  ags := ags || jsonb_build_object({q(key)}, aid); aid := NULL;")
    w("  DELETE FROM customers WHERE company_id = cid AND customer_phone LIKE '9479999%';\n")
    w("  -- ===== delivery =====")
    for area, fee, days, kg, extra in ZONES:
        w(f"  INSERT INTO bot_delivery_zone (company_id, area, fee, days, included_kg, per_extra_kg) VALUES (cid, {q(area)}, {fee}, {q(days)}, {kg}, {extra});")
    w("\n  -- ===== categories and products =====")
    for c in cats:
        w(f"  SELECT id INTO cat_id FROM product_catergory WHERE company_id = cid AND name = {q(c)} LIMIT 1;")
        w(f"  IF cat_id IS NULL THEN INSERT INTO product_catergory (name, company_id, is_active) VALUES ({q(c)}, cid, TRUE) RETURNING id INTO cat_id; END IF;")
        w(f"  cats := cats || jsonb_build_object({q(c)}, cat_id); cat_id := NULL;")
    for i, (cat, name, brand, price, kg, variants, desc, sp) in enumerate(PRODUCTS):
        sku = f"DEMO-{i + 1:03d}"
        if variants:
            opts = []
            for k, (vn, vv, vp) in enumerate(variants):
                ok = vv not in OUT_OF_STOCK.get(name, [])
                opts.append({"variant_name": vn, "variant_value": vv, "price": vp, "sku": f"{sku}-{k + 1:02d}", "quantity": rnd.randint(4, 20) if ok else 0, "available": ok})
            qty = sum(o["quantity"] for o in opts)
            base = min(o["price"] for o in opts)
        else:
            qty, base = rnd.randint(6, 40), price
        w(f"  INSERT INTO product (name, brand, description, sku, price, quantity, status, category_id, company_id, created_by, has_variants, weight, selling_points, is_available, show_to_bot, track_stock, low_stock_level) "
          f"VALUES ({q(name)}, {q(brand)}, {q(desc)}, {q(sku)}, {base}, {qty}, 'In Stock', (cats->>{q(cat)})::int, cid, uid, {q(bool(variants))}, {kg}, {q(sp)}, TRUE, TRUE, TRUE, 3) RETURNING id INTO pid;")
        if variants:
            w(f"  INSERT INTO product_variant (product_id, variants) VALUES (pid, {j(opts)});")
        w(f"  prods := prods || jsonb_build_object({q(name)}, pid);")
    w("\n  -- ===== services =====")
    for name, desc, price, note, mins in SERVICES:
        w(f"  INSERT INTO bot_service (company_id, name, description, price, price_note, duration_min, is_active, is_available) VALUES (cid, {q(name)}, {q(desc)}, {price}, {q(note)}, {mins}, TRUE, TRUE) RETURNING id INTO sid;")
        w(f"  servs := servs || jsonb_build_object({q(name)}, sid);")
    w("\n  -- ===== FAQs =====")
    for cat, qq, a in KNOWLEDGE:
        w(f"  INSERT INTO bot_training_data (company_id, category, question, answer, language, is_active) VALUES (cid, {q(cat)}, {q(qq)}, {q(a)}, 'auto', TRUE);")
    w("\n  -- ===== customer labels (tags) =====")
    for name, color in LABELS:
        w(f"  SELECT id INTO lab FROM bot_customer_label WHERE company_id = cid AND name = {q(name)} LIMIT 1;")
        w(f"  IF lab IS NULL THEN INSERT INTO bot_customer_label (company_id, name, color_code) VALUES (cid, {q(name)}, {q(color)}) RETURNING id INTO lab; END IF;")
        w(f"  labs := labs || jsonb_build_object({q(name)}, lab); lab := NULL;")
    w("\n  -- ===== customers, chats and CRM =====")
    for key, name, platform, ext, phone, lang, stage, tags, deal, source, is_open in CUSTOMERS:
        msgs = CHATS[key]
        first, last = msgs[0][2], msgs[-1][2]
        w(f"  INSERT INTO bot_channel_user (company_id, platform, external_user_id, display_name, language, bot_enabled, manual_mode, last_seen_at, created_at, updated_at) "
          f"VALUES (cid, {q(platform)}, {q(ext)}, {q(name)}, {q(lang)}, TRUE, FALSE, NOW() - INTERVAL '{last} minutes', NOW() - INTERVAL '{first + 60} minutes', NOW()) RETURNING id INTO cu;")
        w(f"  cus := cus || jsonb_build_object({q(key)}, cu);")
        who, mode = ASSIGN[key]
        ag = f"(ags->>{q(who)})::bigint" if who else "NULL"
        status = "active" if key in ACTIVE else ("open" if is_open else "closed")
        accepted = f"NOW() - INTERVAL '{first - 2} minutes'" if who else "NULL"
        w(f"  INSERT INTO bot_conversation (bot_channel_user_id, status, lead_stage, assigned_agent_id, assigned_at, accepted_at, assignment_mode, last_message_at, admin_last_read_at, created_at, updated_at) "
          f"VALUES (cu, {q(status)}, {q(stage)}, {ag}, {accepted}, {accepted}, {q(mode)}, NOW() - INTERVAL '{last} minutes', "
          f"{('NULL' if status != 'closed' else f'NOW() - INTERVAL {chr(39)}{last} minutes{chr(39)}')}, NOW() - INTERVAL '{first} minutes', NOW()) RETURNING id INTO conv;")
        if who and platform == "whatsapp":
            w(f"  INSERT INTO customers (company_id, customer_phone, last_agent_id, last_agent_accepted_at, first_seen_at, last_seen_at) VALUES (cid, {q(ext)}, {ag}, {accepted}, NOW() - INTERVAL '{first} minutes', NOW() - INTERVAL '{last} minutes');")
        w(f"  convs := convs || jsonb_build_object({q(key)}, conv);")
        for direction, text, ago in msgs:
            if direction == "in":
                w(f"  INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source, created_at, updated_at) VALUES (conv, 'inbound', 'text', {q(platform)}, {q(text)}, 'customer', NOW() - INTERVAL '{ago} minutes', NOW() - INTERVAL '{ago} minutes');")
            elif direction == "ai":
                w(f"  INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, llm_provider, created_at, updated_at) VALUES (conv, 'outbound', 'text', {q(platform)}, {q(text)}, 'gemini', NOW() - INTERVAL '{ago} minutes', NOW() - INTERVAL '{ago} minutes');")
            else:
                w(f"  INSERT INTO bot_message (conversation_id, direction, message_type, platform, content, source, sender_user_id, created_at, updated_at) VALUES (conv, 'outbound', 'text', {q(platform)}, {q(text)}, 'agent', {ag}, NOW() - INTERVAL '{ago} minutes', NOW() - INTERVAL '{ago} minutes');")
        all_tags = tags + ["demo"]
        w(f"  INSERT INTO crm_contact (bot_channel_user_id, company_id, phone, tags, deal_value, owner_user_id, source, stage, updated_at) VALUES (cu, cid, {q(phone)}, ARRAY[{', '.join(q(t) for t in all_tags)}]::varchar[], {deal}, {ag if who else 'uid'}, {q(source)}, {q(stage)}, NOW());")
        for t in all_tags:
            w(f"  INSERT INTO bot_contact_tag (company_id, channel_user_id, label_id) VALUES (cid, cu, (labs->>{q(t)})::bigint);")
        path = ["new", "contacted", "qualified", "proposal", "won"]
        steps = path[: path.index(stage) + 1] if stage in path else ["new", "contacted", "lost"]
        for a, b in zip(steps, steps[1:]):
            w(f"  INSERT INTO lead_stage_event (conversation_id, bot_channel_user_id, from_stage, to_stage, changed_at) VALUES (conv, cu, {q(a)}, {q(b)}, NOW() - INTERVAL '{rnd.randint(1, max(2, first // 60))} hours');")
    w("\n  -- ===== customer notes =====")
    for key, text in NOTES_FOR_CUSTOMERS:
        w(f"  INSERT INTO bot_customer_note (company_id, bot_channel_user_id, content, created_by_user_id, created_by_name, checked_by_admin, created_at) VALUES (cid, (cus->>{q(key)})::int, {q(text)}, {agent_id(key)}, {q(agent_name(key))}, TRUE, NOW() - INTERVAL '{rnd.randint(1, 72)} hours');")
    w("\n  -- ===== CRM tasks =====")
    for key, title, days, prio, kind in TASKS:
        w(f"  INSERT INTO crm_task (company_id, bot_channel_user_id, title, due_at, assigned_user_id, status, created_by_user_id, priority, kind) VALUES (cid, (cus->>{q(key)})::int, {q(title)}, NOW() + INTERVAL '{days} days', {agent_id(key)}, 'open', uid, {q(prio)}, {q(kind)});")
    w("\n  -- ===== orders =====")
    weights = {p[1]: p[4] for p in PRODUCTS}
    prices = {p[1]: p[3] for p in PRODUCTS}
    zone = {z[0]: z for z in ZONES}
    cust = {c[0]: c for c in CUSTOMERS}
    for key, status, days, items, area, pay in ORDERS:
        sub = 0
        kg = 0.0
        lines = []
        for name, vtext, qty in items:
            unit = prices[name]
            if vtext and name == "Floral Maxi Dress" and "XL" in vtext:
                unit = 5250
            sub += unit * qty
            kg += weights[name] * qty
            lines.append((name, vtext, qty, unit))
        _, fee, _, inc, extra = zone[area]
        delivery = 0 if sub >= 10000 else fee + max(0, -(-(kg - inc) // 1)) * extra
        delivery = int(delivery)
        total = sub + delivery
        c = cust[key]
        w(f"  INSERT INTO bot_order (company_id, bot_channel_user_id, customer_name, customer_phone, address, status, total_amount, delivery_fee, payment_method, delivery_area, total_weight_kg, agent_id, created_by, created_at, updated_at) "
          f"VALUES (cid, (cus->>{q(key)})::int, {q(c[1])}, {q(c[4])}, {q('No. ' + str(rnd.randint(3, 220)) + ', Main Road, ' + area)}, {q(status)}, {total}, {delivery}, {q(pay)}, {q(area)}, {round(kg, 2)}, {agent_id(key, 'NULL')}, 'bot', "
          f"NOW() - INTERVAL '{days} days 3 hours', NOW() - INTERVAL '{days} days') RETURNING id INTO oid;")
        for name, vtext, qty, unit in lines:
            w(f"  INSERT INTO bot_order_item (order_id, product_id, product_name, variant_text, quantity, unit_price, total_price) VALUES (oid, (prods->>{q(name)})::int, {q(name)}, {q(vtext)}, {qty}, {unit}, {unit * qty});")
        hist = ["Pending", "Cancelled"] if status == "Cancelled" else FLOW[: FLOW.index(status) + 1]
        for n, st in enumerate(hist):
            w(f"  INSERT INTO bot_order_status_history (order_id, status, message, created_at) VALUES (oid, {q(st)}, {q('Order ' + st.lower())}, NOW() - INTERVAL '{days} days 3 hours' + INTERVAL '{n * 5} hours');")
    w("\n  -- ===== bookings =====")
    svc = {s[0]: s for s in SERVICES}
    for key, service, offset, time, status, note in BOOKINGS:
        s = svc[service]
        c = cust[key]
        w(f"  INSERT INTO bot_booking (company_id, bot_channel_user_id, conversation_id, service_id, service_name, date, time, customer_name, customer_phone, notes, status, price, duration_min, agent_id, created_by, created_at, updated_at) "
          f"VALUES (cid, (cus->>{q(key)})::int, (convs->>{q(key)})::int, (servs->>{q(service)})::int, {q(service)}, to_char(CURRENT_DATE + {offset}, 'YYYY-MM-DD'), {q(time)}, {q(c[1])}, {q(c[4])}, {q(note)}, {q(status)}, {s[2]}, {s[4]}, {agent_id(key, 'NULL')}, 'bot', NOW() - INTERVAL '{abs(offset) + 1} days', NOW());")
    w("\n  -- ===== shop notes (the bot reads the ones marked for AI) =====")
    w("  SELECT id INTO tag_imp FROM note_color_tags WHERE (company_id = cid OR company_id IS NULL) AND name = 'Important' ORDER BY company_id NULLS LAST LIMIT 1;")
    w("  IF tag_imp IS NULL THEN INSERT INTO note_color_tags (company_id, name, meaning, color_code) VALUES (cid, 'Important', 'Must know', '#EF4444') RETURNING id INTO tag_imp; END IF;")
    w("  SELECT id INTO tag_info FROM note_color_tags WHERE (company_id = cid OR company_id IS NULL) AND name = 'Info' ORDER BY company_id NULLS LAST LIMIT 1;")
    w("  IF tag_info IS NULL THEN INSERT INTO note_color_tags (company_id, name, meaning, color_code) VALUES (cid, 'Info', 'Good to know', '#3B82F6') RETURNING id INTO tag_info; END IF;")
    for tag, title, content, ai in SHOP_NOTES:
        w(f"  INSERT INTO note (company_id, title, content, created_user_id, color_tag_id, is_selected_for_ai) VALUES (cid, {q(title)}, {q(content)}, uid, {'tag_imp' if tag == 'Important' else 'tag_info'}, {q(ai)});")
    w("\n  -- ===== quick replies and social saved replies =====")
    for name, title, body in TEMPLATES:
        w(f"  INSERT INTO bot_message_template (company_id, name, title, body, buttons, platforms) VALUES (cid, {q(name)}, {q(title)}, {q(body)}, '[]'::jsonb, '[\"whatsapp\",\"messenger\",\"instagram\"]'::jsonb);")
    for kind, title, text in SAVED_REPLIES:
        w(f"  INSERT INTO social_saved_reply (company_id, kind, title, text, created_by) VALUES (cid, {q(kind)}, {q(title)}, {q(text)}, uid);")
    w("\n  -- ===== forms and flows (flows are PAUSED – switch them on in Auto flows when you want them to run) =====")
    for n, (slug, name, title, intro, fields, thanks, tags, stage) in enumerate(FORMS):
        w(f"  INSERT INTO chat_form (company_id, name, slug, title, intro, fields, thank_you, add_tags, set_stage, notify, active, created_by) "
          f"VALUES (cid, {q(name)}, 'demo-{slug}-' || cid, {q(title)}, {q(intro)}, {j(fields)}, {q(thanks)}, ARRAY[{', '.join(q(t) for t in tags)}]::text[], {q(stage)}, TRUE, TRUE, uid) RETURNING id INTO fid;")
        if n == 0:
            w("  sid := fid;  -- the salon form, used by the welcome flow")
    for name, desc, status, trig, cfg, steps in flows(-1):
        steps_sql = j(steps).replace('"form_id": -1', '"form_id": __FORM__')
        steps_sql = steps_sql.replace("__FORM__", "' || sid || '")
        w(f"  INSERT INTO automation_flow (company_id, name, description, status, trigger_type, trigger_config, channels, steps, priority, definition, runs, completed) "
          f"VALUES (cid, {q(name)}, {q(desc)}, {q(status)}, {q(trig)}, {j(cfg)}, ARRAY['whatsapp','messenger','instagram']::text[], ({steps_sql[:-7]})::jsonb, 0, '{{}}'::jsonb, {rnd.randint(20, 140)}, {rnd.randint(10, 60)});")
    w("\n  -- ===== marketing: campaign and short links =====")
    w("  INSERT INTO marketing_campaign (company_id, name, status, starts_at, ends_at, offer_text, bot_instructions, product_ids, tag, created_by) "
      "VALUES (cid, 'December Sale 2026', 'active', CURRENT_DATE, CURRENT_DATE + 30, '20% off all dresses until 31 December', "
      "'If a customer came from the December Sale, give 20% off dresses (not bridal).', "
      "jsonb_build_array((prods->>'Floral Maxi Dress')::int, (prods->>'Blue Linen Frock')::int, (prods->>'Office Wrap Dress')::int), 'december-sale', uid) RETURNING id INTO camp;")
    w("  INSERT INTO marketing_link (company_id, slug, name, channel, target, prefill_text, campaign_id, tag, is_active, clicks, created_by) "
      "VALUES (cid, 'demosale' || cid, 'December Sale – Facebook ad', 'whatsapp', (SELECT COALESCE(NULLIF(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), ''), '94718191000') FROM companies WHERE id = cid), 'Hi! I saw the December Sale 😊', camp, 'december-sale', TRUE, 214, uid);")
    w("  INSERT INTO marketing_link (company_id, slug, name, channel, target, prefill_text, campaign_id, tag, is_active, clicks, created_by) "
      "VALUES (cid, 'demosalon' || cid, 'Salon booking – shop QR code', 'whatsapp', (SELECT COALESCE(NULLIF(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), ''), '94718191000') FROM companies WHERE id = cid), 'Hi! I want to book the salon', NULL, 'salon', TRUE, 57, uid);")
    w("\n  -- ===== income and expenses =====")
    w("  SELECT id INTO ecat FROM expenses_catergory WHERE company_id = cid AND name = 'Stock purchase' LIMIT 1;")
    w("  IF ecat IS NULL THEN INSERT INTO expenses_catergory (name, company_id, is_active) VALUES ('Stock purchase', cid, TRUE) RETURNING id INTO ecat; END IF;")
    w("  SELECT id INTO icat FROM income_catergory WHERE company_id = cid AND name = 'Salon services' LIMIT 1;")
    w("  IF icat IS NULL THEN INSERT INTO income_catergory (name, company_id, is_active) VALUES ('Salon services', cid, TRUE) RETURNING id INTO icat; END IF;")
    for days, amount, note in [(3, 85000, "New dresses from supplier"), (10, 12000, "Facebook ads"), (18, 45000, "Bathik sarees stock"), (25, 8500, "Packing material")]:
        w(f"  INSERT INTO expense (company_id, date, amount, note, sourse, created_user_id, expense_category_id) VALUES (cid, NOW() - INTERVAL '{days} days', {amount}, {q(note)}, 'demo', uid, ecat);")
    for days, amount, note in [(2, 22500, "Bridal advance – Dilini"), (6, 13500, "Salon – 3 facials"), (13, 18000, "Salon – hair and make-up")]:
        w(f"  INSERT INTO income (company_id, date, amount, note, sourse, created_user_id, income_category_id) VALUES (cid, NOW() - INTERVAL '{days} days', {amount}, {q(note)}, 'demo', uid, icat);")
    w("""END $$;
COMMIT;

-- Hide the Customer app from every company it was switched on for automatically (Super admin can switch it on again).
DELETE FROM company_feature_access WHERE feature = 'customer_app' AND note = 'Already used the app';

-- check:
-- SELECT (SELECT COUNT(*) FROM product p JOIN app_user u ON u.company_id = p.company_id WHERE LOWER(u.email) = LOWER('""" + EMAIL + """') AND p.sku LIKE 'DEMO-%') AS products,
--        (SELECT COUNT(*) FROM bot_order o JOIN app_user u ON u.company_id = o.company_id WHERE LOWER(u.email) = LOWER('""" + EMAIL + """')) AS orders;""")
    print("\n".join(out))


if __name__ == "__main__":
    main()
