const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://postgres.mavvvesnkbxdijdqlswo:RsXetvks8nsx0X3t@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log('Connected to DB');

  await client.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS business_category TEXT DEFAULT 'product',
      ADD COLUMN IF NOT EXISTS order_collect_customer_info BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_collect_products BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS order_allow_note BOOLEAN DEFAULT TRUE;
  `);
  console.log('Migration complete');

  const res = await client.query(
    "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'companies' ORDER BY ordinal_position"
  );
  console.log('Columns:', res.rows.map(r => r.column_name).join(', '));
  await client.end();
}

run().catch(console.error);
