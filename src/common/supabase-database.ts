import { getEnvValue } from './env';

export function getSupabaseDatabaseUrl(): string {
  return (
    getEnvValue('PRODUCT_DATABASE_URL', '') ||
    getEnvValue('SUPABASE_DATABASE_URL', '')
  );
}

/** Named TypeORM connection for Supabase Postgres; undefined = use MySQL fallbacks. */
export const SUPABASE_DATA_SOURCE = getSupabaseDatabaseUrl() ? 'supabase' : undefined;

/** @deprecated Use SUPABASE_DATA_SOURCE */
export const PRODUCT_DATA_SOURCE = SUPABASE_DATA_SOURCE;
