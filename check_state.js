require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.PRODUCT_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  const res = await client.query('SELECT id, status, assigned_agent_id, bot_channel_user_id FROM bot_conversation ORDER BY id');
  console.log('Conversations:', res.rows);
  await client.end();
}

run().catch(console.error);
