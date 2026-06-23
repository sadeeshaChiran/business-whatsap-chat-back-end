const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.mavvvesnkbxdijdqlswo:RsXetvks8nsx0X3t@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  const res = await client.query("UPDATE bot_conversation SET status = 'pending', assigned_agent_id = 10, assigned_at = NOW() WHERE status = 'open'");
  console.log(res.rowCount);
  await client.end();
}

run().catch(console.error);
