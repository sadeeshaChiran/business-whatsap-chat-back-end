"""
Add a company 13 product with variant_image_match and real web product images.

Usage:
  python api/scripts/add_company13_match_product.py
  python api/scripts/add_company13_match_product.py --mode color-size
"""
from __future__ import annotations

import argparse
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

# Google-hosted sample photos (stable public URLs).
IMAGE_SOURCES = {
    "red_shoe": "https://www.gstatic.com/webp/gallery/1.jpg",
    "blue_shoe": "https://www.gstatic.com/webp/gallery/2.jpg",
    "red_alt": "https://www.gstatic.com/webp/gallery/3.jpg",
    "blue_alt": "https://www.gstatic.com/webp/gallery/4.jpg",
}

load_dotenv(API_ROOT / ".env")
load_dotenv(BOT_ROOT / ".env", override=True)


def db_url() -> str:
    url = (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or "").strip()
    if not url:
        print("Missing PRODUCT_DATABASE_URL", file=sys.stderr)
        sys.exit(1)
    return url


def download_image(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "business-health-scanner-seed/1.0", "Accept": "image/*"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
        payload = response.read()
    return f"data:{content_type};base64,{base64.b64encode(payload).decode('ascii')}"


def ensure_category(cur, company_id: int) -> int:
    cur.execute(
        """
        INSERT INTO product_catergory (name, company_id, is_common, is_active)
        VALUES (%s, %s, FALSE, TRUE)
        ON CONFLICT (company_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        """,
        ("Baby Shoes", company_id),
    )
    return int(cur.fetchone()[0])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("color", "color-size"),
        default="color",
        help="color = 2 images (Red/Blue). color-size = 4 combination images.",
    )
    args = parser.parse_args()

    suffix = int(time.time())
    red_img = download_image(IMAGE_SOURCES["red_shoe"])
    blue_img = download_image(IMAGE_SOURCES["blue_shoe"])
    cover = red_img

    if args.mode == "color-size":
        red_s = red_img
        red_m = download_image(IMAGE_SOURCES["red_alt"])
        blue_s = download_image(IMAGE_SOURCES["blue_alt"])
        blue_m = blue_img
        variant_image_match = {
            "dimensions": ["Color", "Size"],
            "images": {
                "Red / S": red_s,
                "Red / M": red_m,
                "Blue / S": blue_s,
                "Blue / M": blue_m,
            },
        }
        variants = [
            {
                "variant_name": "Color / Size",
                "variant_value": "Red / S",
                "price": 3500,
                "quantity": 4,
                "sku": f"C13-RS-{suffix}",
            },
            {
                "variant_name": "Color / Size",
                "variant_value": "Red / M",
                "price": 3500,
                "quantity": 4,
                "sku": f"C13-RM-{suffix}",
            },
            {
                "variant_name": "Color / Size",
                "variant_value": "Blue / S",
                "price": 3500,
                "quantity": 4,
                "sku": f"C13-BS-{suffix}",
            },
            {
                "variant_name": "Color / Size",
                "variant_value": "Blue / M",
                "price": 3500,
                "quantity": 4,
                "sku": f"C13-BM-{suffix}",
            },
        ]
        product_name = f"Google Baby Shoes Color+Size {suffix}"
        description = "Baby shoes with Color+Size variant match images (4 photos from Google samples)."
    else:
        variant_image_match = {
            "dimensions": ["Color"],
            "images": {
                "Red": red_img,
                "Blue": blue_img,
            },
        }
        variants = [
            {
                "variant_name": "Color",
                "variant_value": "Red",
                "price": 3200,
                "quantity": 6,
                "sku": f"C13-RED-{suffix}",
            },
            {
                "variant_name": "Color",
                "variant_value": "Blue",
                "price": 3200,
                "quantity": 6,
                "sku": f"C13-BLU-{suffix}",
            },
        ]
        product_name = f"Google Baby Shoes Color {suffix}"
        description = "Baby shoes with Color variant match images (Red/Blue photos from Google samples)."

    conn = psycopg2.connect(db_url(), sslmode="require")
    product_id = 0
    created_by = 1
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM app_user WHERE company_id = %s ORDER BY id LIMIT 1",
                    (COMPANY_ID,),
                )
                row = cur.fetchone()
                if not row:
                    raise RuntimeError(f"No user found for company_id={COMPANY_ID}")
                created_by = int(row[0])
                category_id = ensure_category(cur, COMPANY_ID)

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
                        product_name,
                        description,
                        f"G13-{suffix}",
                        3200,
                        sum(int(v.get("quantity") or 0) for v in variants),
                        "In Stock",
                        category_id,
                        COMPANY_ID,
                        created_by,
                        cover,
                        Json([cover, blue_img]),
                        0.28,
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
        "product_name": product_name,
        "mode": args.mode,
        "match_dimensions": variant_image_match["dimensions"],
        "match_image_keys": list(variant_image_match["images"].keys()),
        "variant_count": len(variants),
    }

    out = API_ROOT / "scripts" / "add_company13_match_product.result.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"\nSaved: {out}")

    bot_base = (os.getenv("BOT_BASE_URL") or "http://127.0.0.1:5005").rstrip("/")
    try:
        payload = json.dumps({"company_id": COMPANY_ID, "user_id": created_by}).encode("utf-8")
        request = urllib.request.Request(
            f"{bot_base}/bot/sync/catalog",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            sync = json.loads(response.read().decode("utf-8"))
            print("Vector sync:", json.dumps(sync.get("stats", sync)))
    except Exception as exc:
        print(f"Vector sync skipped (start bot on :5005 and use Sync to Vector DB): {exc}")


if __name__ == "__main__":
    main()
