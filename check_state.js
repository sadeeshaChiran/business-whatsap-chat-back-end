const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.mavvvesnkbxdijdqlswo:RsXetvks8nsx0X3t@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  const res = await client.query('SELECT id, status, assigned_agent_id, bot_channel_user_id FROM bot_conversation ORDER BY id');
  console.log('Conversations:', res.rows);
  await client.end();
}

run().catch(console.error);
