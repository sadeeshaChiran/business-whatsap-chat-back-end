/**
 * The last Messenger / Instagram webhook events per company (kept in memory only, no message text), shown in the
 * Channels connection check. Answers "Meta says connected, but my ad chats look like normal chats – what does Meta
 * actually send?": an ad click shows as "ad click (ADS, ad 123…)"; a reply to the ad card shows as "reply to …".
 * With META_WEBHOOK_LOG=1 the full raw events are also written to the server log (for developers).
 */
export type MetaEventSummary = {
  at: string;
  platform: 'messenger' | 'instagram';
  kind: string;
  details: string[];
};

const MAX = 30;
const events = new Map<number, MetaEventSummary[]>();

export function summarizeMetaEvent(event: Record<string, any>): { kind: string; details: string[] } {
  const message = event.message as Record<string, any> | undefined;
  const referral = (event.referral ?? message?.referral ?? event.postback?.referral) as Record<string, any> | undefined;
  const details: string[] = [];
  let kind = 'other';
  if (event.read) kind = 'read';
  else if (event.delivery) kind = 'delivered';
  else if (event.reaction) kind = 'reaction';
  else if (message?.is_echo) kind = 'page message (echo)';
  else if (message) kind = 'customer message';
  else if (event.postback) kind = 'button tap';
  else if (event.referral) kind = 'ad / link click';
  if (referral) {
    const ctx = referral.ads_context_data as Record<string, any> | undefined;
    details.push(`referral: ${[referral.source, referral.type, referral.ad_id ? `ad ${referral.ad_id}` : '', referral.ref ? `ref ${referral.ref}` : '', ctx?.ad_title ? 'has ad title' : '', ctx?.photo_url || ctx?.video_url ? 'has ad media' : '', ctx?.post_id ? `post ${ctx.post_id}` : ''].filter(Boolean).join(', ') || 'yes'}`);
  }
  if (message?.reply_to?.mid) details.push('reply to an earlier message');
  if (message?.reply_to?.story) details.push('reply to a story');
  const types = ((message?.attachments ?? []) as Array<{ type?: string }>).map((a) => a.type).filter(Boolean);
  if (types.length) details.push(`attachments: ${types.join(', ')}`);
  if (message?.is_echo) details.push(message.app_id ? `sent by app ${message.app_id}` : 'sent from Meta (Inbox / Business Suite / ad)');
  if (message?.quick_reply) details.push('quick reply');
  return { kind, details };
}

export function recordMetaEvent(companyId: number, platform: 'messenger' | 'instagram', event: Record<string, any>) {
  const { kind, details } = summarizeMetaEvent(event);
  if (kind === 'read' || kind === 'delivered') return; // ticks are noise here
  const list = events.get(companyId) ?? [];
  list.unshift({ at: new Date().toISOString(), platform, kind, details });
  events.set(companyId, list.slice(0, MAX));
}

export function recentMetaEvents(companyId: number, platform?: 'messenger' | 'instagram'): MetaEventSummary[] {
  return (events.get(companyId) ?? []).filter((e) => !platform || e.platform === platform);
}
