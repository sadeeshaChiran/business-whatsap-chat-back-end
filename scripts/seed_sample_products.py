"""
Insert sample products (and categories) for a company in the product Supabase DB.

Usage:
  python api/scripts/seed_sample_products.py --company-id 12
  python api/scripts/seed_sample_products.py --company-id 12 --created-by 5
  python api/scripts/seed_sample_products.py --company-id 12 --reset

Requires PRODUCT_DATABASE_URL or SUPABASE_DATABASE_URL in api/.env or bot/.env.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json

API_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = API_ROOT.parent / "bot"

if not (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL")):
    load_dotenv(API_ROOT / ".env")
    load_dotenv(BOT_ROOT / ".env", override=True)

SEED_SKU_PREFIX = "SEED-{company_id}-"

CATEGORIES = ("Electronics", "Clothing", "Services")


def sample_products(company_id: int) -> list[dict]:
    prefix = SEED_SKU_PREFIX.format(company_id=company_id)
    return [
        {
            "sku": f"{prefix}HEADPHONES",
            "name": "Wireless Bluetooth Headphones",
            "description": "Noise-cancelling over-ear headphones with 30h battery life.",
            "category": "Electronics",
            "price": 79.99,
            "secondary_price_1": 69.99,
            "secondary_price_2": 0,
            "quantity": 45,
            "status": "In Stock",
            "has_variants": False,
            "variants": [],
        },
        {
            "sku": f"{prefix}USBC-HUB",
            "name": "USB-C Multiport Hub",
            "description": "7-in-1 hub with HDMI, USB 3.0, and SD card reader.",
            "category": "Electronics",
            "price": 34.5,
            "secondary_price_1": 0,
            "secondary_price_2": 0,
            "quantity": 8,
            "status": "Low Stock",
            "has_variants": False,
            "variants": [],
        },
        {
            "sku": f"{prefix}TSHIRT",
            "name": "Organic Cotton T-Shirt",
            "description": "Soft unisex tee available in multiple colors and sizes.",
            "category": "Clothing",
            "price": 24.0,
            "secondary_price_1": 0,
            "secondary_price_2": 0,
            "quantity": 120,
            "status": "In Stock",
            "has_variants": True,
            "variants": [
                {"variant_name": "Color", "variant_value": "Black"},
                {"variant_name": "Size", "variant_value": "M"},
                {"variant_name": "Color", "variant_value": "Navy"},
                {"variant_name": "Size", "variant_value": "L"},
            ],
        },
        {
            "sku": f"{prefix}DESK-CHAIR",
            "name": "Ergonomic Office Chair",
            "description": "Adjustable lumbar support and breathable mesh back.",
            "category": "Electronics",
            "price": 199.0,
            "secondary_price_1": 179.0,
            "secondary_price_2": 0,
            "quantity": 0,
            "status": "Out of Stock",
            "has_variants": False,
            "variants": [],
        },
        {
            "sku": f"{prefix}CONSULT",
            "name": "Business Health Consultation",
            "description": "One-hour session with a business health advisor.",
            "category": "Services",
            "price": 150.0,
            "secondary_price_1": 0,
            "secondary_price_2": 0,
            "quantity": 999,
            "status": "Service",
            "has_variants": False,
            "variants": [],
        },
        {
            "sku": f"{prefix}NOTEBOOK",
            "name": "Hardcover Planner Notebook",
            "description": "A5 weekly planner with goal-tracking sections.",
            "category": "Services",
            "price": 18.75,
            "secondary_price_1": 0,
            "secondary_price_2": 0,
            "quantity": 60,
            "status": "In Stock",
            "has_variants": True,
            "variants": [
                {"variant_name": "Cover", "variant_value": "Blue"},
                {"variant_name": "Cover", "variant_value": "Green"},
            ],
        },
    ]


def get_database_url() -> str:
    url = (
        os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or ""
    ).strip()
    if not url:
        print(
            "PRODUCT_DATABASE_URL or SUPABASE_DATABASE_URL is required",
            file=sys.stderr,
        )
        sys.exit(1)
    return url


def ensure_category(cur, company_id: int, name: str) -> int:
    cur.execute(
        """
        INSERT INTO product_catergory (name, company_id, is_common, is_active)
        VALUES (%s, %s, FALSE, TRUE)
        ON CONFLICT (company_id, name) DO UPDATE
          SET name = EXCLUDED.name
        RETURNING id
        """,
        (name, company_id),
    )
    row = cur.fetchone()
    if row:
        return int(row[0])

    cur.execute(
        """
        SELECT id FROM product_catergory
        WHERE company_id = %s AND name = %s
        LIMIT 1
        """,
        (company_id, name),
    )
    found = cur.fetchone()
    if not found:
        raise RuntimeError(f"Failed to resolve category id for {name!r}")
    return int(found[0])


def delete_seed_products(cur, company_id: int) -> int:
    sku_pattern = f"SEED-{company_id}-%"
    cur.execute(
        """
        DELETE FROM product_variant
        WHERE product_id IN (
          SELECT id FROM product
          WHERE company_id = %s AND sku LIKE %s
        )
        """,
        (company_id, sku_pattern),
    )
    cur.execute(
        """
        DELETE FROM product
        WHERE company_id = %s AND sku LIKE %s
        RETURNING id
        """,
        (company_id, sku_pattern),
    )
    deleted = cur.fetchall()
    return len(deleted)


def product_exists(cur, company_id: int, sku: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM product
        WHERE company_id = %s AND sku = %s AND is_deleted = FALSE
        LIMIT 1
        """,
        (company_id, sku),
    )
    return cur.fetchone() is not None


def insert_product(
    cur,
    company_id: int,
    created_by: int,
    category_id: int,
    item: dict,
) -> int:
    cur.execute(
        """
        INSERT INTO product (
          name, description, sku, price, secondary_price_1, secondary_price_2,
          quantity, status, category_id, company_id, created_by,
          has_variants, is_deleted
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE)
        RETURNING id
        """,
        (
            item["name"],
            item["description"],
            item["sku"],
            item["price"],
            item["secondary_price_1"],
            item["secondary_price_2"],
            item["quantity"],
            item["status"],
            category_id,
            company_id,
            created_by,
            item["has_variants"],
        ),
    )
    product_id = int(cur.fetchone()[0])

    if item["has_variants"] and item["variants"]:
        cur.execute(
            """
            INSERT INTO product_variant (product_id, variants)
            VALUES (%s, %s)
            ON CONFLICT (product_id) DO UPDATE
              SET variants = EXCLUDED.variants
            """,
            (product_id, Json(item["variants"])),
        )

    return product_id


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed sample products for a company in the product database.",
    )
    parser.add_argument(
        "--company-id",
        type=int,
        required=True,
        help="Company id to attach products to (product.company_id).",
    )
    parser.add_argument(
        "--created-by",
        type=int,
        default=1,
        help="User id stored in product.created_by (default: 1).",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete existing SEED-{company_id}-* products before inserting.",
    )
    args = parser.parse_args()

    if args.company_id < 1:
        print("--company-id must be a positive integer", file=sys.stderr)
        sys.exit(1)

    if args.created_by < 1:
        print("--created-by must be a positive integer", file=sys.stderr)
        sys.exit(1)

    url = get_database_url()
    products = sample_products(args.company_id)

    conn = psycopg2.connect(url, sslmode="require")
    try:
        with conn:
            with conn.cursor() as cur:
                if args.reset:
                    removed = delete_seed_products(cur, args.company_id)
                    print(f"Removed {removed} existing seed product(s).")

                category_ids: dict[str, int] = {}
                for name in CATEGORIES:
                    category_ids[name] = ensure_category(
                        cur, args.company_id, name
                    )
                print(
                    "Categories:",
                    ", ".join(f"{n}={category_ids[n]}" for n in CATEGORIES),
                )

                inserted = 0
                skipped = 0
                for item in products:
                    if product_exists(cur, args.company_id, item["sku"]):
                        skipped += 1
                        print(f"  skip (exists): {item['sku']} — {item['name']}")
                        continue

                    category_id = category_ids[item["category"]]
                    product_id = insert_product(
                        cur,
                        args.company_id,
                        args.created_by,
                        category_id,
                        item,
                    )
                    inserted += 1
                    variant_note = (
                        f", variants={len(item['variants'])}"
                        if item["has_variants"]
                        else ""
                    )
                    print(
                        f"  added id={product_id}: {item['sku']} — {item['name']}{variant_note}"
                    )

        print(
            f"\nDone. company_id={args.company_id}, inserted={inserted}, skipped={skipped}."
        )
        print("SKUs use prefix:", SEED_SKU_PREFIX.format(company_id=args.company_id))
        print("Re-run with --reset to replace seed products.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
