"""
Seed company 13 with a product using variant_image_match (Color: Red/Blue images).

Usage:
  python api/scripts/seed_company13_match_images.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json

API_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = API_ROOT.parent / "bot"
COMPANY_ID = 13

load_dotenv(API_ROOT / ".env")
load_dotenv(BOT_ROOT / ".env", override=True)


def db_url() -> str:
    url = (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or "").strip()
    if not url:
        print("Missing PRODUCT_DATABASE_URL", file=sys.stderr)
        sys.exit(1)
    return url


def download_image(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "bhs-seed/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
        payload = response.read()
    return f"data:{content_type};base64,{base64.b64encode(payload).decode('ascii')}"


def main() -> None:
    suffix = int(time.time())
    red = download_image("https://www.gstatic.com/webp/gallery/1.jpg")
    blue = download_image("https://www.gstatic.com/webp/gallery/2.jpg")
    cover = red

    variants = [
        {
            "variant_name": "Color",
            "variant_value": "Red",
            "price": 3200,
            "quantity": 5,
            "sku": f"C13-RED-{suffix}",
        },
        {
            "variant_name": "Color",
            "variant_value": "Blue",
            "price": 3200,
            "quantity": 5,
            "sku": f"C13-BLU-{suffix}",
        },
    ]
    variant_image_match = {
        "dimensions": ["Color"],
        "images": {
            "Red": red,
            "Blue": blue,
        },
    }

    conn = psycopg2.connect(db_url(), sslmode="require")
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM app_user WHERE company_id = %s ORDER BY id LIMIT 1",
                    (COMPANY_ID,),
                )
                created_by = int(cur.fetchone()[0])

                cur.execute(
                    """
                    INSERT INTO product_catergory (name, company_id, is_common, is_active)
                    VALUES (%s, %s, FALSE, TRUE)
                    ON CONFLICT (company_id, name) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                    """,
                    ("Baby Shoes", COMPANY_ID),
                )
                category_id = int(cur.fetchone()[0])

                cur.execute(
                    """
                    INSERT INTO product (
                      name, description, sku, price, quantity, status,
                      category_id, company_id, created_by,
                      has_variants, image_url, gallery, weight,
                      variant_image_match, is_deleted
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, TRUE, %s, %s, %s, %s, FALSE)
                    RETURNING id
                    """,
                    (
                        f"Match Image Shoes {suffix}",
                        "Color match images: Red and Blue",
                        f"MATCH-13-{suffix}",
                        3200,
                        10,
                        "In Stock",
                        category_id,
                        COMPANY_ID,
                        created_by,
                        cover,
                        Json([cover]),
                        0.25,
                        Json(variant_image_match),
                    ),
                )
                product_id = int(cur.fetchone()[0])
                cur.execute(
                    """
                    INSERT INTO product_variant (product_id, variants)
                    VALUES (%s, %s)
                    ON CONFLICT (product_id) DO UPDATE SET variants = EXCLUDED.variants
                    """,
                    (product_id, Json(variants)),
                )
    finally:
        conn.close()

    result = {
        "company_id": COMPANY_ID,
        "product_id": product_id,
        "variant_image_match": variant_image_match,
    }
    out = API_ROOT / "scripts" / "seed_company13_match_images.result.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
