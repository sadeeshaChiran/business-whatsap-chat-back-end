import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Client } from 'pg';
import { getSupabaseDatabaseUrl } from './supabase-database';

const MIGRATION_FILES = [
  'supabase_product_image_url.sql',
  'supabase_product_gallery_weight.sql',
  'supabase_drop_secondary_prices.sql',
  'supabase_product_variant_image_match.sql',
  'supabase_product_variant_price_match.sql',
  'supabase_meta_page_connections.sql',
  'supabase_agent_routing.sql',
  'supabase_agent_last_read_at.sql',
  'supabase_agent_accept_sticky.sql',
  'supabase_whatsapp_provider.sql',
  'supabase_whatsapp_meta_verify_token.sql',
  'supabase_whatsapp_meta_webhook_base.sql',
  'supabase_bot_channel_user_company_scope.sql',
] as const;

function migrationDir(): string | null {
  const candidates = [
    resolve(process.cwd(), 'migrations'),
    resolve(__dirname, '../../migrations'),
    resolve(__dirname, '../../../migrations'),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (const char of sql) {
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
}

export async function runStartupMigrations(): Promise<void> {
  const databaseUrl = getSupabaseDatabaseUrl();
  if (!databaseUrl) {
    return;
  }

  const dir = migrationDir();
  if (!dir) {
    console.warn('[migrations] migrations folder not found; skipping');
    return;
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    for (const filename of MIGRATION_FILES) {
      const filePath = resolve(dir, filename);
      if (!existsSync(filePath)) {
        console.warn(`[migrations] missing file: ${filename}`);
        continue;
      }

      const sql = readFileSync(filePath, 'utf8');
      for (const statement of splitSqlStatements(sql)) {
        if (!statement) {
          continue;
        }
        try {
          await client.query(statement);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[migrations] skipped statement in ${filename}: ${message}`,
          );
        }
      }
      console.log(`[migrations] applied ${filename}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[migrations] startup migrations failed: ${message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
