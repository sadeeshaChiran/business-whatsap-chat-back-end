import { Logger } from '@nestjs/common';

type MetaErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string; fbtrace_id?: string };
};

const logger = new Logger('MetaSendError');

/**
 * Turns a failed Meta Send API answer into one clear line and logs Meta's error code and subcode,
 * so a page-specific problem (permissions, routing, restrictions) can be found from the server log.
 * Tokens are never logged.
 */
export function metaSendError(result: unknown, status: number, fallback: string, context: Record<string, unknown> = {}): string {
  const error = (result as MetaErrorBody | null)?.error ?? {};
  const message = error.message || fallback;
  const code = error.code != null ? `#${error.code}${error.error_subcode != null ? `/${error.error_subcode}` : ''}` : `HTTP ${status}`;
  logger.warn(`Meta send failed (${code}) ${message} | type=${error.type ?? '-'} trace=${error.fbtrace_id ?? '-'} ${JSON.stringify(context)}`);
  return `${message} (${code})`;
}
