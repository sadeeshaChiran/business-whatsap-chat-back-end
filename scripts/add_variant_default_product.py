"""
Add a 2-variant product with one shared default cover image for a company.

Usage:
  python api/scripts/add_variant_default_product.py --company-id 13
  python api/scripts/add_variant_default_product.py --company-id 13 --sync-vector
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

if not (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL")):
    load_dotenv(API_ROOT / ".env")
    load_dotenv(BOT_ROOT / ".env", override=True)

DEFAULT_IMAGE_URL = os.getenv(
    "TEST_PRODUCT_IMAGE_URL",
    "https://www.gstatic.com/webp/gallery/1.jpg",
)
BOT_BASE_URL = (os.getenv("BOT_BASE_URL") or "http://localhost:5005").rstrip("/")


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


def download_as_data_url(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "business-health-scanner-seed/1.0",
            "Accept": "image/*,*/*",
        },
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


def insert_product(
    cur,
    *,
    company_id: int,
    created_by: int,
    category_id: int,
    name: str,
    description: str,
    sku: str,
    price: float,
    quantity: int,
    cover_image: str,
    variants: list[dict],
) -> int:
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
            name,
            description,
            sku,
            price,
            quantity,
            "In Stock",
            category_id,
            company_id,
            created_by,
            cover_image,
            Json([cover_image]),
            0.25,
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
        (product_id, Json(variants)),
    )
    return product_id


def sync_catalog(company_id: int, user_id: int) -> dict:
    import urllib.error

    payload = json.dumps({"company_id": company_id, "user_id": user_id}).encode("utf-8")
    request = urllib.request.Request(
        f"{BOT_BASE_URL}/bot/sync/catalog",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Vector sync failed ({exc.code}): {body}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add 2-variant product with shared default cover image.",
    )
    parser.add_argument("--company-id", type=int, required=True)
    parser.add_argument(
        "--sync-vector",
        action="store_true",
        help="Call POST /bot/sync/catalog after insert.",
    )
    parser.add_argument(
        "--name",
        default="",
        help="Product name (default: Baby Shoes Test <timestamp>).",
    )
    args = parser.parse_args()

    if args.company_id < 1:
        print("--company-id must be positive", file=sys.stderr)
        sys.exit(1)

    suffix = int(time.time())
    product_name = args.name.strip() or f"Baby Shoes Test {suffix}"
    sku = f"VD-{args.company_id}-{suffix}"
    cover_image = download_as_data_url(DEFAULT_IMAGE_URL)

    variants = [
        {
            "variant_name": "Color",
            "variant_value": "Red",
            "price": 3200,
            "quantity": 5,
            "sku": f"RED-{suffix}",
            "use_default_image": True,
        },
        {
            "variant_name": "Color",
            "variant_value": "Blue",
            "price": 3200,
            "quantity": 5,
            "sku": f"BLU-{suffix}",
            "use_default_image": True,
        },
    ]

    conn = psycopg2.connect(get_database_url(), sslmode="require")
    try:
        with conn:
            with conn.cursor() as cur:
                created_by = resolve_created_by(cur, args.company_id)
                category_id = ensure_category(cur, args.company_id, "Baby Shoes")
                product_id = insert_product(
                    cur,
                    company_id=args.company_id,
                    created_by=created_by,
                    category_id=category_id,
                    name=product_name,
                    description="Two color variants sharing one default cover image.",
                    sku=sku,
                    price=3200,
                    quantity=10,
                    cover_image=cover_image,
                    variants=variants,
                )
    finally:
        conn.close()

    result = {
        "company_id": args.company_id,
        "product_id": product_id,
        "product_name": product_name,
        "sku": sku,
        "variants": ["Red", "Blue"],
        "use_default_image": True,
        "cover_kb": round(len(cover_image) / 1024),
    }

    if args.sync_vector:
        try:
            sync_stats = sync_catalog(args.company_id, created_by)
            result["vector_sync"] = sync_stats.get("stats", sync_stats)
        except RuntimeError as exc:
            result["vector_sync_error"] = str(exc)
            print(f"Warning: {exc}", file=sys.stderr)

    out_path = API_ROOT / "scripts" / f"add_variant_default_company_{args.company_id}.result.json"
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(json.dumps(result, indent=2))
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
