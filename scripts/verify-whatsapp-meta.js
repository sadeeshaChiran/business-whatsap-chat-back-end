/**
 * Quick sanity check for Meta WhatsApp dashboard integration.
 * Usage: node scripts/verify-whatsapp-meta.js
 */
const { Client } = require('pg');
const { config } = require('dotenv');
const { resolve } = require('path');

config({ path: resolve(__dirname, '../.env') });

const API_BASE = (process.env.PUBLIC_API_BASE_URL || `http://localhost:${process.env.PORT || 6001}/v1/api`).replace(/\/+$/, '');

async function main() {
  const databaseUrl =
    process.env.PRODUCT_DATABASE_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('No database URL in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const col = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'whatsapp_channels' AND column_name = 'meta_verify_token'
  `);
  console.log(col.rows.length ? 'OK  meta_verify_token column exists' : 'FAIL meta_verify_token column missing');

  const channels = await client.query(`
    SELECT id, company_id, provider_type, meta_phone_number_id,
           meta_verify_token IS NOT NULL AS has_verify_token,
           meta_access_token IS NOT NULL AS has_access_token
    FROM whatsapp_channels
    ORDER BY id
  `);
  console.log(`OK  whatsapp_channels rows: ${channels.rows.length}`);
  for (const row of channels.rows) {
    console.log(`    #${row.id} company=${row.company_id} provider=${row.provider_type} phone_id=${row.meta_phone_number_id || '-'} verify=${row.has_verify_token} token=${row.has_access_token}`);
  }

  const metaRow = channels.rows.find((r) => r.provider_type === 'meta' && r.has_verify_token);
  const testToken = metaRow
    ? (await client.query('SELECT meta_verify_token FROM whatsapp_channels WHERE id = $1', [metaRow.id])).rows[0].meta_verify_token
    : 'test-verify-token-not-in-db';

  await client.end();

  const invalidUrl = `${API_BASE}/integrations/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=__invalid__&hub.challenge=challenge123`;
  const invalidRes = await fetch(invalidUrl);
  const invalidBody = await invalidRes.text();
  console.log(invalidBody === 'Forbidden' ? 'OK  invalid verify token -> Forbidden' : `FAIL invalid verify: ${invalidRes.status} ${invalidBody}`);

  if (metaRow) {
    const validUrl = `${API_BASE}/integrations/whatsapp/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(testToken)}&hub.challenge=challenge123`;
    const validRes = await fetch(validUrl);
    const validBody = await validRes.text();
    console.log(validBody === 'challenge123' ? 'OK  valid verify token -> challenge echoed' : `FAIL valid verify: ${validRes.status} ${validBody}`);
  } else {
    console.log('SKIP valid verify token test (no meta channel with verify token in DB)');
  }

  const expectedWebhook = `${API_BASE}/integrations/whatsapp/webhook/meta`;
  console.log(`OK  expected webhook URL: ${expectedWebhook}`);

  const metaPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: channels.rows.find((r) => r.meta_phone_number_id)?.meta_phone_number_id || '999' },
          messages: [{ from: '94771234567', id: 'wamid.test', type: 'text', text: { body: 'hello' }, timestamp: '1710000000' }],
        },
      }],
    }],
  };
  const inboundRes = await fetch(`${API_BASE}/integrations/whatsapp/webhook/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metaPayload),
  });
  const inboundJson = await inboundRes.json();
  console.log(inboundRes.ok ? `OK  inbound webhook POST -> ${JSON.stringify(inboundJson)}` : `FAIL inbound: ${inboundRes.status}`);

  const configRes = await fetch(`${API_BASE}/integrations/whatsapp/config`);
  console.log(configRes.status === 401 ? 'OK  /config requires auth (401)' : `WARN /config status ${configRes.status} (expected 401 without JWT)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
