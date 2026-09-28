require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  connectionString: process.env.PRODUCT_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  const res = await client.query("UPDATE bot_conversation SET status = 'pending', assigned_agent_id = 10, assigned_at = NOW() WHERE status = 'open'");
  console.log(res.rowCount);
  await client.end();
}

run().catch(console.error);
