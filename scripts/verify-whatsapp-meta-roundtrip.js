/**
 * Round-trip: set meta channel on company 13, verify webhook + routing, restore.
 */
const { Client } = require('pg');
const { config } = require('dotenv');
const { resolve } = require('path');

config({ path: resolve(__dirname, '../.env') });

const API_BASE = `http://localhost:${process.env.PORT || 3001}/v1/api`;
const TEST_VERIFY = 'cursor-e2e-verify-token';
const TEST_PHONE_ID = '123456789012345';

async function main() {
  const databaseUrl = process.env.PRODUCT_DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const before = await client.query(
    `SELECT id, provider_type, meta_phone_number_id, meta_verify_token, meta_access_token
     FROM whatsapp_channels WHERE company_id = 13 LIMIT 1`,
  );
  const row = before.rows[0];
  if (!row) {
    console.log('SKIP no channel for company 13');
    await client.end();
    return;
  }

  await client.query(
    `UPDATE whatsapp_channels
     SET provider_type = 'meta',
         meta_phone_number_id = $1,
         meta_verify_token = $2,
         meta_access_token = 'test-token-not-real',
         status = 'CONNECTED'
     WHERE id = $3`,
    [TEST_PHONE_ID, TEST_VERIFY, row.id],
  );
  await client.end();

  const verifyRes = await fetch(
    `${API_BASE}/integrations/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(TEST_VERIFY)}&hub.challenge=e2e-challenge`,
  );
  const verifyBody = await verifyRes.text();
  console.log(verifyBody === 'e2e-challenge' ? 'OK  round-trip verify challenge' : `FAIL verify: ${verifyBody}`);

  const inboundRes = await fetch(`${API_BASE}/integrations/whatsapp/webhook/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: TEST_PHONE_ID },
            messages: [{
              from: '94770000001',
              id: 'wamid.e2e',
              type: 'text',
              text: { body: 'e2e test' },
              timestamp: '1710000001',
            }],
          },
        }],
      }],
    }),
  });
  const inbound = await inboundRes.json();
  console.log(
    inbound.routed && inbound.company_id === 13
      ? 'OK  inbound routed to company 13'
      : `FAIL routing: ${JSON.stringify(inbound)}`,
  );

  const client2 = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client2.connect();
  await client2.query(
    `UPDATE whatsapp_channels
     SET provider_type = $1,
         meta_phone_number_id = $2,
         meta_verify_token = $3,
         meta_access_token = $4,
         status = $5
     WHERE id = $6`,
    [
      row.provider_type,
      row.meta_phone_number_id,
      row.meta_verify_token,
      row.meta_access_token,
      'DISCONNECTED',
      row.id,
    ],
  );
  await client2.end();
  console.log('OK  restored company 13 channel');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
