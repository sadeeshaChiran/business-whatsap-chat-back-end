import { getEnvValue } from './env';

export function getSupabaseDatabaseUrl(): string {
  return (
    getEnvValue('PRODUCT_DATABASE_URL', '') ||
    getEnvValue('SUPABASE_DATABASE_URL', '')
  );
}

/**
 * SSL options for the Postgres connection.
 * DB_SSL=false turns SSL off (local Postgres). DB_SSL_REJECT_UNAUTHORIZED=true verifies the certificate.
 */
export function getDatabaseSsl(): false | { rejectUnauthorized: boolean } {
  if (getEnvValue('DB_SSL', 'true').toLowerCase() === 'false') return false;
  return { rejectUnauthorized: getEnvValue('DB_SSL_REJECT_UNAUTHORIZED', 'false').toLowerCase() === 'true' };
}
