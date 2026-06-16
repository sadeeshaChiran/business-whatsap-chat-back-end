/**
 * Live test: product with 2 variants sharing one default cover image,
 * bot image resolution, and catalog vector sync.
 *
 * Usage:
 *   node api/scripts/test_variant_default_product.mjs
 *   API_BASE_URL=http://localhost:3001/v1/api BOT_BASE_URL=http://localhost:5005 node api/scripts/test_variant_default_product.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001/v1/api";
const botBase = (process.env.BOT_BASE_URL ?? "http://localhost:5005").replace(/\/+$/, "");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// Public product-style sample (Google-hosted gstatic sample works without hotlink blocks).
const SAMPLE_IMAGE_URL =
  process.env.TEST_PRODUCT_IMAGE_URL ??
  "https://www.gstatic.com/webp/gallery/1.jpg";

const randomSuffix = Date.now();

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function downloadAsDataUrl(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "business-health-scanner-test/1.0",
      Accept: "image/*,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Image download failed (${response.status}): ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "image/jpeg";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function runBotImageUnitTests() {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      `
import sys
sys.path.insert(0, r"${path.join(repoRoot, "bot").replace(/\\/g, "\\\\")}")
from app.external.services.product_image_service import (
    build_variant_image_entries,
    variant_uses_default_image,
)

cover = "data:image/jpeg;base64,abc"
variants = [
    {"variant_name": "Color", "variant_value": "Red", "use_default_image": True},
    {"variant_name": "Color", "variant_value": "Blue", "use_default_image": True},
]
assert variant_uses_default_image(variants[0])
entries = build_variant_image_entries(
    company_id=1,
    product_id=99,
    variants=variants,
    main_image_url=cover,
    gallery=[],
)
assert len(entries) == 1, entries
print("bot_unit_ok")
`,
    ],
    { encoding: "utf8", cwd: path.join(repoRoot, "bot") },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Bot unit test failed");
  }
}

async function main() {
  console.log("1) Bot unit tests (shared default image dedupe)...");
  runBotImageUnitTests();
  console.log("   OK");

  console.log("2) Download sample product image...");
  const coverDataUrl = await downloadAsDataUrl(SAMPLE_IMAGE_URL);
  console.log(`   Downloaded ${Math.round(coverDataUrl.length / 1024)} KB data URL`);

  console.log("3) Register test user + category...");
  const registerResponse = await request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `variant-default-${randomSuffix}@example.com`,
      password: "VariantTest123!",
      name: "Variant Default Tester",
      company: { name: `Variant Default Co ${randomSuffix}` },
    }),
  });

  const token = registerResponse?.data?.access_token ?? registerResponse?.access_token;
  const user = registerResponse?.data?.user ?? registerResponse?.user;
  if (!token || !user?.company_id) {
    throw new Error(`Register failed: ${JSON.stringify(registerResponse)}`);
  }

  const categoryResponse = await request("/product-catergory", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      name: `Baby Shoes ${randomSuffix}`,
      is_active: true,
      is_common: false,
    }),
  });
  const categoryId = categoryResponse?.data?.id ?? categoryResponse?.id;
  if (!categoryId) {
    throw new Error(`Category create failed: ${JSON.stringify(categoryResponse)}`);
  }

  console.log("4) Create product with 2 variants (default cover for both)...");
  const productResponse = await request("/products", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      name: `Baby Shoes Test ${randomSuffix}`,
      description: "Two color variants sharing one default cover image.",
      price: 3200,
      quantity: 10,
      category_id: categoryId,
      has_variants: true,
      weight: 0.25,
      gallery: [coverDataUrl],
      image_url: coverDataUrl,
      variants: [
        {
          variant_name: "Color",
          variant_value: "Red",
          price: 3200,
          quantity: 5,
          sku: `RED-${randomSuffix}`,
          use_default_image: true,
        },
        {
          variant_name: "Color",
          variant_value: "Blue",
          price: 3200,
          quantity: 5,
          sku: `BLU-${randomSuffix}`,
          use_default_image: true,
        },
      ],
    }),
  });

  const product = productResponse?.data ?? productResponse;
  if (!product?.id) {
    throw new Error(`Product create failed: ${JSON.stringify(productResponse)}`);
  }

  const variants = product.variants ?? [];
  if (variants.length !== 2) {
    throw new Error(`Expected 2 variants, got ${variants.length}`);
  }
  for (const row of variants) {
    if (row.use_default_image !== true) {
      throw new Error(`Variant missing use_default_image=true: ${JSON.stringify(row)}`);
    }
    if (row.image_url?.trim()) {
      throw new Error(`Variant should not have custom image_url: ${JSON.stringify(row)}`);
    }
  }
  console.log(`   Product id=${product.id}, variants OK`);

  console.log("5) Re-fetch product and verify persistence...");
  const fetched = await request(`/products/${product.id}`, {
    headers: authHeaders(token),
  });
  const saved = fetched?.data ?? fetched;
  if ((saved.variants ?? []).length !== 2) {
    throw new Error("Re-fetch variant count mismatch");
  }
  console.log("   OK");

  console.log("6) Sync catalog to vector DB...");
  const syncResponse = await fetch(`${botBase}/bot/sync/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_id: Number(user.company_id),
      user_id: Number(user.id),
    }),
  });
  const syncPayload = await syncResponse.json().catch(() => ({}));
  if (!syncResponse.ok) {
    throw new Error(
      `Vector sync failed (${syncResponse.status}): ${JSON.stringify(syncPayload)}`,
    );
  }
  const upserted = syncPayload?.stats?.products_upserted ?? 0;
  console.log(`   Sync OK — products_upserted=${upserted}`);

  const summary = {
    product_id: product.id,
    company_id: user.company_id,
    variant_values: variants.map((row) => row.variant_value),
    shared_default_cover: true,
    vector_sync: syncPayload?.stats ?? syncPayload,
  };

  const outPath = path.resolve(__dirname, "test_variant_default_product.result.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log("\nAll tests passed.");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nResult saved: ${outPath}`);
}

main().catch((error) => {
  console.error("\nTEST FAILED:", error.message || error);
  process.exit(1);
});
