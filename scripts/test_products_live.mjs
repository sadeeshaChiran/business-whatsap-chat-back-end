import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3001/v1/api';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const randomSuffix = Date.now();
const testUser = {
  email: `product-test-${randomSuffix}@example.com`,
  password: 'ProductTest123!',
  name: 'Product Tester',
  company: {
    name: `Product Test Co ${randomSuffix}`,
  },
};

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options);
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function main() {
  console.log('Registering test user...');
  const registerResponse = await request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testUser),
  });

  const token = registerResponse?.data?.access_token ?? registerResponse?.access_token;
  if (!token) {
    throw new Error(`Missing access token: ${JSON.stringify(registerResponse)}`);
  }

  console.log('Creating category...');
  const categoryResponse = await request('/product-catergory', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name: `Import Test ${randomSuffix}`,
      is_active: true,
      is_common: false,
    }),
  });

  const categoryId = categoryResponse?.data?.id ?? categoryResponse?.id;
  if (!categoryId) {
    throw new Error(`Missing category id: ${JSON.stringify(categoryResponse)}`);
  }

  const gallery = [
    'https://example.com/product-cover.jpg',
    'https://example.com/product-alt.jpg',
  ];

  console.log('Creating simple product...');
  const simpleProductResponse = await request('/products', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name: `Simple Product ${randomSuffix}`,
      description: 'Live test simple product',
      sku: `SKU-${randomSuffix}`,
      price: 999,
      quantity: 12,
      category_id: categoryId,
      has_variants: false,
      weight: 0.45,
      gallery,
      image_url: gallery[0],
      variants: [],
    }),
  });

  const simpleProduct = simpleProductResponse?.data ?? simpleProductResponse;
  if (!simpleProduct?.id) {
    throw new Error(`Simple product create failed: ${JSON.stringify(simpleProductResponse)}`);
  }

  console.log('Creating variant product...');
  const variantProductResponse = await request('/products', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name: `Variant Product ${randomSuffix}`,
      description: 'Live test variant product',
      price: 1500,
      quantity: 0,
      category_id: categoryId,
      has_variants: true,
      weight: 0.3,
      gallery,
      image_url: gallery[0],
      variants: [
        {
          variant_name: 'Color / Size',
          variant_value: 'Red / M',
          price: 1500,
          quantity: 5,
          sku: `RED-M-${randomSuffix}`,
          image_url: gallery[0],
        },
        {
          variant_name: 'Color / Size',
          variant_value: 'Blue / L',
          quantity: 3,
          sku: `BLU-L-${randomSuffix}`,
          image_url: gallery[1],
        },
      ],
    }),
  });

  const variantProduct = variantProductResponse?.data ?? variantProductResponse;
  if (!variantProduct?.id || !(variantProduct?.variants ?? []).length) {
    throw new Error(
      `Variant product create failed: ${JSON.stringify(variantProductResponse)}`,
    );
  }

  if (variantProduct.variants[1].price !== 1500) {
    throw new Error(
      `Variant price fallback failed: ${JSON.stringify(variantProduct.variants[1])}`,
    );
  }

  console.log('Importing sample CSV...');
  const sampleCsvPath = path.resolve(__dirname, 'sample_product_import.csv');
  const csvBuffer = fs.readFileSync(sampleCsvPath);
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([csvBuffer], { type: 'text/csv' }),
    'sample_product_import.csv',
  );

  const importResponse = await fetch(`${apiBase}/products/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  const importPayload = await importResponse.json();
  if (!importResponse.ok) {
    throw new Error(`Import failed (${importResponse.status}): ${JSON.stringify(importPayload)}`);
  }

  const importedCount =
    importPayload?.data?.imported_count ?? importPayload?.imported_count ?? 0;
  if (importedCount < 2) {
    throw new Error(`Expected at least 2 imported products: ${JSON.stringify(importPayload)}`);
  }

  console.log('Listing products...');
  const listResponse = await request('/products', {
    headers: authHeaders(token),
  });
  const products = listResponse?.data ?? listResponse;
  if (!Array.isArray(products) || products.length < 4) {
    throw new Error(`Expected products in list: ${JSON.stringify(listResponse)}`);
  }

  console.log('Cleaning up created products...');
  const createdNames = [
    simpleProduct.name,
    variantProduct.name,
    'Baby Wipes Pack',
    'Baby Onesie',
  ];

  for (const product of products) {
    if (createdNames.includes(product.name)) {
      await request(`/products/${product.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
    }
  }

  console.log('PASS: products create, variant fallback, import, list, delete');
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
