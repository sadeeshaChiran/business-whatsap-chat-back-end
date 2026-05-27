"""Run supabase_product_variant_json.sql against PRODUCT_DATABASE_URL."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

API_ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = API_ROOT.parent / "bot"
if not (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL")):
    load_dotenv(API_ROOT / ".env")
    load_dotenv(BOT_ROOT / ".env", override=True)

url = (os.getenv("PRODUCT_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL") or "").strip()
if not url:
    print("PRODUCT_DATABASE_URL or SUPABASE_DATABASE_URL is required", file=sys.stderr)
    sys.exit(1)

sql_path = API_ROOT / "migrations" / "supabase_product_variant_json.sql"
sql = sql_path.read_text(encoding="utf-8")

conn = psycopg2.connect(url, sslmode="require")
conn.autocommit = True
cur = conn.cursor()

cur.execute(
    """
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'product_variant'
    ORDER BY ordinal_position
    """
)
cols = [row[0] for row in cur.fetchall()]
print("Current columns:", cols)

if "variant_name" not in cols and "variants" in cols:
    print("Migration already applied.")
else:
    cur.execute(sql)
    print("Migration executed successfully.")

cur.execute(
    """
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'product_variant'
    ORDER BY ordinal_position
    """
)
print("Final columns:", [row[0] for row in cur.fetchall()])

cur.execute(
    """
    SELECT product_id, COUNT(*) AS c
    FROM product_variant
    GROUP BY product_id
    HAVING COUNT(*) > 1
    """
)
dupes = cur.fetchall()
print("Duplicate product_id rows:", dupes or "none")

cur.execute("SELECT COUNT(*) FROM product_variant")
print("Total product_variant rows:", cur.fetchone()[0])

cur.close()
conn.close()
