import { getEnvValue } from './env';

export function getSupabaseDatabaseUrl(): string {
  return (
    getEnvValue('PRODUCT_DATABASE_URL', '') ||
    getEnvValue('SUPABASE_DATABASE_URL', '')
  );
}

/** Legacy named connection; app uses a single default Postgres pool now. */
export const SUPABASE_DATA_SOURCE = getSupabaseDatabaseUrl() ? 'supabase' : undefined;

export const PRODUCT_DATA_SOURCE = SUPABASE_DATA_SOURCE;
