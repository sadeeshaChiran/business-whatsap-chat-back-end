"""
Create a test bot order for a conversation customer using 2 random company products.
One product qty 2 (single variant), second product qty 1 (single variant).

Usage:
  python api/scripts/seed_test_bot_order.py --conversation-id 38
  python api/scripts/seed_test_bot_order.py --conversation-id 38 --company-id 20
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

API_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = API_ROOT.parent / "bot"

load_dotenv(API_ROOT / ".env")
load_dotenv(BOT_ROOT / ".env", override=True)


def db_url() -> str:
    url = (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or "").strip()
    if not url:
        print("PRODUCT_DATABASE_URL or SUPABASE_DATABASE_URL is required", file=sys.stderr)
        sys.exit(1)
    return url


def parse_variants(raw) -> list[dict]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        return json.loads(raw)
    return []


def variant_label(variant: dict) -> str:
    name = str(variant.get("variant_name") or "").strip()
    value = str(variant.get("variant_value") or "").strip()
    if name and value:
        if value.startswith(name):
            return value
        if " / " in name or name == value:
            return value
        return f"{name} / {value}"
    return value or name or ""


def load_conversation(cur, conversation_id: int) -> dict:
    cur.execute(
        """
        SELECT c.id, cu.company_id, c.bot_channel_user_id, c.status,
               cu.display_name, cu.external_user_id, cu.platform
        FROM bot_conversation c
        JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        WHERE c.id = %s
        LIMIT 1
        """,
        (conversation_id,),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"Conversation {conversation_id} not found")
    return {
        "conversation_id": int(row[0]),
        "company_id": int(row[1]),
        "bot_channel_user_id": int(row[2]),
        "status": str(row[3]),
        "display_name": str(row[4] or "").strip(),
        "external_user_id": str(row[5] or "").strip(),
        "platform": str(row[6] or "").strip(),
    }


def load_products(cur, company_id: int, sku_prefix: str | None = None) -> list[dict]:
    params: list = [company_id]
    sku_filter = ""
    if sku_prefix:
        sku_filter = " AND p.sku LIKE %s"
        params.append(f"{sku_prefix}%")

    cur.execute(
        f"""
        SELECT p.id, p.name, p.price, pv.variants
        FROM product p
        LEFT JOIN product_variant pv ON pv.product_id = p.id
        WHERE p.company_id = %s
          AND p.is_deleted = FALSE
          {sku_filter}
        ORDER BY p.id
        """,
        tuple(params),
    )
    products: list[dict] = []
    for product_id, name, price, variants_raw in cur.fetchall():
        variants = parse_variants(variants_raw)
        if not variants:
            variants = [
                {
                    "variant_name": "Default",
                    "variant_value": "Standard",
                    "price": float(price or 0),
                }
            ]
        products.append(
            {
                "id": int(product_id),
                "name": str(name),
                "variants": variants,
            }
        )
    if len(products) < 2:
        raise RuntimeError(
            f"Need at least 2 products for company_id={company_id}; found {len(products)}"
        )
    return products


def pick_order_lines(products: list[dict], rng: random.Random) -> list[dict]:
    chosen = rng.sample(products, 2)
    first, second = chosen[0], chosen[1]
    first_variant = rng.choice(first["variants"])
    second_variant = rng.choice(second["variants"])

    first_price = float(first_variant.get("price") or 0)
    second_price = float(second_variant.get("price") or 0)
    first_qty = 2
    second_qty = 1

    return [
        {
            "product_id": first["id"],
            "product_name": first["name"],
            "variant_text": variant_label(first_variant),
            "quantity": first_qty,
            "unit_price": first_price,
            "total_price": first_price * first_qty,
        },
        {
            "product_id": second["id"],
            "product_name": second["name"],
            "variant_text": variant_label(second_variant),
            "quantity": second_qty,
            "unit_price": second_price,
            "total_price": second_price * second_qty,
        },
    ]


def insert_order(cur, conversation: dict, items: list[dict]) -> int:
    customer_name = conversation["display_name"] or conversation["external_user_id"]
    customer_phone = conversation["external_user_id"]
    total_amount = sum(float(item["total_price"]) for item in items)

    cur.execute(
        """
        INSERT INTO bot_order (
          company_id, bot_channel_user_id,
          customer_name, customer_phone, address,
          status, total_amount
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            conversation["company_id"],
            conversation["bot_channel_user_id"],
            customer_name,
            customer_phone,
            "Colombo — test order from seed script",
            "Confirmed",
            total_amount,
        ),
    )
    order_id = int(cur.fetchone()[0])

    for item in items:
        cur.execute(
            """
            INSERT INTO bot_order_item (
              order_id, product_id, product_name, variant_text,
              quantity, unit_price, total_price
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                order_id,
                item["product_id"],
                item["product_name"],
                item["variant_text"],
                item["quantity"],
                item["unit_price"],
                item["total_price"],
            ),
        )

    cur.execute(
        """
        INSERT INTO bot_order_status_history (order_id, status, message)
        VALUES (%s, %s, %s)
        """,
        (order_id, "Confirmed", "Test order seeded for conversation customer."),
    )
    return order_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed a test bot order for a conversation customer.")
    parser.add_argument("--conversation-id", type=int, default=38)
    parser.add_argument("--company-id", type=int, default=0, help="Optional company filter for products")
    parser.add_argument("--sku-prefix", default="SEED-20-", help="Product SKU prefix filter")
    parser.add_argument("--seed", type=int, default=0, help="Random seed (0 = random each run)")
    args = parser.parse_args()

    rng = random.Random(args.seed if args.seed else None)
    conn = psycopg2.connect(db_url(), sslmode="require")
    try:
        with conn:
            with conn.cursor() as cur:
                conversation = load_conversation(cur, args.conversation_id)
                company_id = args.company_id or conversation["company_id"]
                if company_id != conversation["company_id"]:
                    raise RuntimeError(
                        f"Conversation {args.conversation_id} belongs to company "
                        f"{conversation['company_id']}, not {company_id}"
                    )

                products = load_products(cur, company_id, args.sku_prefix.strip() or None)
                items = pick_order_lines(products, rng)
                order_id = insert_order(cur, conversation, items)

        print(f"Created test order #{order_id}")
        print(
            f"Customer: {conversation['display_name']} ({conversation['external_user_id']}) "
            f"conversation_id={conversation['conversation_id']} "
            f"bot_channel_user_id={conversation['bot_channel_user_id']}"
        )
        print(f"Company: {conversation['company_id']}")
        for item in items:
            print(
                f"  - {item['product_name']} ({item['variant_text']}) "
                f"x{item['quantity']} @ Rs {item['unit_price']} = Rs {item['total_price']}"
            )
        print(f"Total: Rs {sum(i['total_price'] for i in items)}")
        print(f"View: http://localhost:3000/admin-bot-conversations/{args.conversation_id}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
