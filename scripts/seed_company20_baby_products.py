"""
Seed 3 baby products with variants for company 20:
  - Baby Toy
  - Baby Diapers
  - Baby Milk

Usage:
  python api/scripts/seed_company20_baby_products.py
  python api/scripts/seed_company20_baby_products.py --reset
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
import urllib.request
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json

API_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = API_ROOT.parent / "bot"
COMPANY_ID = 20
CATEGORY_NAME = "Baby Products"
SKU_PREFIX = f"SEED-{COMPANY_ID}-"
DEFAULT_IMAGE_URL = "https://www.gstatic.com/webp/gallery/1.jpg"

load_dotenv(API_ROOT / ".env")
load_dotenv(BOT_ROOT / ".env", override=True)


def db_url() -> str:
    url = (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or "").strip()
    if not url:
        print("PRODUCT_DATABASE_URL or SUPABASE_DATABASE_URL is required", file=sys.stderr)
        sys.exit(1)
    return url


def download_as_data_url(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "business-health-scanner-seed/1.0", "Accept": "image/*,*/*"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
        payload = response.read()
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def resolve_created_by(cur, company_id: int) -> int:
    cur.execute(
        """
        SELECT id FROM app_user
        WHERE company_id = %s AND is_active = TRUE
        ORDER BY id ASC
        LIMIT 1
        """,
        (company_id,),
    )
    row = cur.fetchone()
    if row:
        return int(row[0])
    cur.execute("SELECT id FROM app_user ORDER BY id ASC LIMIT 1")
    fallback = cur.fetchone()
    if not fallback:
        raise RuntimeError("No app_user row found for created_by")
    return int(fallback[0])


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
        raise RuntimeError(f"Failed to resolve category {name!r}")
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
    return len(cur.fetchall())


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
    *,
    company_id: int,
    created_by: int,
    category_id: int,
    item: dict,
    cover_image: str,
) -> int:
    total_qty = sum(int(v.get("quantity") or 0) for v in item["variants"])
    cur.execute(
        """
        INSERT INTO product (
          name, description, sku, price, quantity, status,
          category_id, company_id, created_by,
          has_variants, image_url, gallery, weight, is_deleted
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE, %s, %s, %s, FALSE)
        RETURNING id
        """,
        (
            item["name"],
            item["description"],
            item["sku"],
            item["price"],
            total_qty,
            "In Stock",
            category_id,
            company_id,
            created_by,
            cover_image,
            Json([cover_image]),
            item.get("weight", 0.3),
        ),
    )
    product_id = int(cur.fetchone()[0])
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


def sample_products() -> list[dict]:
    prefix = SKU_PREFIX
    return [
        {
            "sku": f"{prefix}BABY-TOY",
            "name": "Baby Soft Toy",
            "description": "Soft plush baby toy. Safe for newborns. Available in multiple colors.",
            "price": 1250,
            "weight": 0.15,
            "variants": [
                {
                    "variant_name": "Color",
                    "variant_value": "Blue",
                    "price": 1250,
                    "quantity": 20,
                    "sku": f"{prefix}TOY-BLU",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Color",
                    "variant_value": "Pink",
                    "price": 1250,
                    "quantity": 18,
                    "sku": f"{prefix}TOY-PNK",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Color",
                    "variant_value": "Yellow",
                    "price": 1300,
                    "quantity": 15,
                    "sku": f"{prefix}TOY-YEL",
                    "use_default_image": True,
                },
            ],
        },
        {
            "sku": f"{prefix}BABY-DIAPERS",
            "name": "Baby Diapers",
            "description": "Premium baby diapers. Soft, absorbent, and comfortable for daily use.",
            "price": 850,
            "weight": 0.5,
            "variants": [
                {
                    "variant_name": "Size",
                    "variant_value": "Newborn (0-3 kg)",
                    "price": 750,
                    "quantity": 30,
                    "sku": f"{prefix}DPR-NB",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Size",
                    "variant_value": "Small (3-6 kg)",
                    "price": 850,
                    "quantity": 40,
                    "sku": f"{prefix}DPR-SM",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Size",
                    "variant_value": "Medium (6-12 kg)",
                    "price": 950,
                    "quantity": 35,
                    "sku": f"{prefix}DPR-MD",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Size",
                    "variant_value": "Large (12-18 kg)",
                    "price": 1050,
                    "quantity": 25,
                    "sku": f"{prefix}DPR-LG",
                    "use_default_image": True,
                },
            ],
        },
        {
            "sku": f"{prefix}BABY-MILK",
            "name": "Baby Milk Powder",
            "description": "Nutritious infant formula milk powder for healthy baby growth.",
            "price": 2200,
            "weight": 0.9,
            "variants": [
                {
                    "variant_name": "Stage / Size",
                    "variant_value": "Stage 1 / 400g",
                    "price": 1800,
                    "quantity": 25,
                    "sku": f"{prefix}MLK-S1-400",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Stage / Size",
                    "variant_value": "Stage 1 / 900g",
                    "price": 3200,
                    "quantity": 20,
                    "sku": f"{prefix}MLK-S1-900",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Stage / Size",
                    "variant_value": "Stage 2 / 400g",
                    "price": 1900,
                    "quantity": 22,
                    "sku": f"{prefix}MLK-S2-400",
                    "use_default_image": True,
                },
                {
                    "variant_name": "Stage / Size",
                    "variant_value": "Stage 2 / 900g",
                    "price": 3400,
                    "quantity": 18,
                    "sku": f"{prefix}MLK-S2-900",
                    "use_default_image": True,
                },
            ],
        },
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=f"Seed baby products for company {COMPANY_ID}.")
    parser.add_argument(
        "--reset",
        action="store_true",
        help=f"Delete existing SEED-{COMPANY_ID}-* products before inserting.",
    )
    args = parser.parse_args()

    print(f"Downloading cover image from {DEFAULT_IMAGE_URL}...")
    cover_image = download_as_data_url(DEFAULT_IMAGE_URL)

    conn = psycopg2.connect(db_url(), sslmode="require")
    try:
        with conn:
            with conn.cursor() as cur:
                if args.reset:
                    removed = delete_seed_products(cur, COMPANY_ID)
                    print(f"Removed {removed} existing seed product(s).")

                created_by = resolve_created_by(cur, COMPANY_ID)
                category_id = ensure_category(cur, COMPANY_ID, CATEGORY_NAME)
                print(f"company_id={COMPANY_ID}, created_by={created_by}, category_id={category_id}")

                inserted = 0
                skipped = 0
                for item in sample_products():
                    if product_exists(cur, COMPANY_ID, item["sku"]):
                        skipped += 1
                        print(f"  skip (exists): {item['sku']} — {item['name']}")
                        continue

                    product_id = insert_product(
                        cur,
                        company_id=COMPANY_ID,
                        created_by=created_by,
                        category_id=category_id,
                        item=item,
                        cover_image=cover_image,
                    )
                    inserted += 1
                    print(
                        f"  added id={product_id}: {item['name']} "
                        f"({len(item['variants'])} variants)"
                    )

        print(f"\nDone. inserted={inserted}, skipped={skipped}.")
        print("Products: Baby Soft Toy, Baby Diapers, Baby Milk Powder")
        print("Sync catalog in the dashboard if the bot needs Pinecone vectors.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
