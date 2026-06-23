const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.mavvvesnkbxdijdqlswo:RsXetvks8nsx0X3t@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  const res = await client.query('SELECT id, name, email FROM app_user WHERE company_id = $1', ['13']);
  console.log(res.rows);
  const conv = await client.query('SELECT id, bot_channel_user_id, status, assigned_agent_id FROM bot_conversation WHERE company_id = $1 OR id=1', ['13']);
  console.log(conv.rows);
  await client.end();
}

run().catch(console.error);
