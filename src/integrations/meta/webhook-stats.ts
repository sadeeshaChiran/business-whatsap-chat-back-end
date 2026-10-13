/**
 * What the Meta webhooks did since the API started (kept in memory, shown in the Channels connection check).
 * Answers the common question "Meta says connected, but no messages arrive – is Meta calling us at all?".
 */
export type WebhookKind = 'whatsapp' | 'messenger';
type Stat = { received_at: string | null; accepted_at: string | null; rejected_at: string | null; reason: string | null; count: number };

const empty = (): Stat => ({ received_at: null, accepted_at: null, rejected_at: null, reason: null, count: 0 });
const stats: Record<WebhookKind, Stat> = { whatsapp: empty(), messenger: empty() };
export const startedAt = new Date().toISOString();

export function webhookReceived(kind: WebhookKind) {
  stats[kind].received_at = new Date().toISOString();
  stats[kind].count += 1;
}
export function webhookAccepted(kind: WebhookKind) {
  stats[kind].accepted_at = new Date().toISOString();
}
export function webhookRejected(kind: WebhookKind, reason: string) {
  stats[kind].rejected_at = new Date().toISOString();
  stats[kind].reason = reason;
}
export function webhookStats(kind: WebhookKind): Stat {
  return { ...stats[kind] };
}
export function resetWebhookStats() {
  stats.whatsapp = empty();
  stats.messenger = empty();
}

/** One line for the connection check: ok = true (last call accepted), false (last call rejected), null (no call yet). */
export function webhookCheck(kind: WebhookKind): { ok: boolean | null; detail: string } {
  const s = stats[kind];
  if (!s.received_at) {
    return { ok: null, detail: `Meta has not called the webhook since the server started (${startedAt.slice(0, 16).replace('T', ' ')} UTC). Send a test message, then press “Check again”.` };
  }
  // messages keep arriving → fine, even if another (old) Meta app's calls are refused now and then
  const recentAccept = s.accepted_at && Date.now() - new Date(s.accepted_at).getTime() < 24 * 3600_000;
  const lastRejected = s.rejected_at && (!s.accepted_at || s.rejected_at > s.accepted_at);
  if (lastRejected && !recentAccept) return { ok: false, detail: `Last call was refused: ${s.reason}` };
  const note = lastRejected ? ` Some calls were refused (${s.reason})` : '';
  return { ok: true, detail: `Last message from Meta: ${s.accepted_at?.slice(0, 19).replace('T', ' ')} UTC (${s.count} since start).${note}` };
}
