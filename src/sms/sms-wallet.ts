import type { DataSource, EntityManager } from 'typeorm';

/**
 * Agent Metra SMS credits: 1 credit = 1 SMS part. Free credits come from the package every month (used first, not carried
 * over); bought credits (SMS packs) stay until used. Used by the SMS module and by Billing (a paid SMS pack).
 */
type Db = DataSource | EntityManager;

/** "2026-10" in Sri Lanka time – the free credits start again every month. */
export const smsMonth = (at = new Date()) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 7);

/** Adds (or with a negative number takes away) bought credits. A ref is used once (a payment is never added twice). */
export async function addSmsCredits(db: Db, companyId: number, credits: number, kind: 'buy' | 'adjust', note: string, ref: string | null, userId: number | null) {
  const rows: Array<{ id: number }> = await db.query(`
    INSERT INTO sms_wallet_tx (company_id, credits, kind, note, ref, created_by) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING RETURNING id`, [companyId, Math.trunc(credits), kind, note.slice(0, 300), ref, userId]);
  if (!rows.length) return false;
  await db.query(`INSERT INTO sms_wallet (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
  await db.query(`UPDATE sms_wallet SET balance = GREATEST(0, balance + $2), updated_at = NOW() WHERE company_id = $1`, [companyId, Math.trunc(credits)]);
  return true;
}
