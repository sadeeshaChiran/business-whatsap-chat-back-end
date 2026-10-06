import type { DataSource } from 'typeorm';
import { sriLankaToday } from '../platform/package-offer';

/**
 * Links a chat to the marketing campaign / short link / ad that brought the customer.
 * Used by the webhook capture (all channels), the background scan and – just before the AI answers –
 * by the sales bot context, so the bot already knows the campaign on the first reply.
 */

/** A chat stays linked to a campaign for this long after the customer came from it. */
export const CAMPAIGN_DAYS = 7;

/** "#summer25" at the end of a short-link message (we add it to the ready text). */
const LINK_TAG = /#([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\b/gi;

export const normaliseText = (value: string) => String(value ?? '').toLowerCase().replace(/#[a-z0-9-]+/gi, ' ').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

export function linkTags(text: string): string[] {
  return [...String(text ?? '').matchAll(LINK_TAG)].map((match) => match[1].toLowerCase()).slice(0, 5);
}

type Source = 'ad' | 'link' | 'broadcast';

async function link(ds: DataSource, conversationId: number, values: { campaignId: number | null; source: Source; linkId?: number | null }) {
  await ds.query(
    `UPDATE bot_conversation SET campaign_id = $2, campaign_source = $3, campaign_at = NOW(), link_id = COALESCE($4, link_id) WHERE id = $1`,
    [conversationId, values.campaignId, values.source, values.linkId ?? null],
  );
}

/** CRM contact: where the customer came from + the campaign / link tag (for audiences and broadcasts). */
async function tagContact(ds: DataSource, conversationId: number, source: string, tag: string) {
  const clean = String(tag ?? '').trim().toLowerCase().slice(0, 40);
  await ds.query(`
    INSERT INTO crm_contact (bot_channel_user_id, company_id, source, tags)
    SELECT cu.id, cu.company_id, $2, CASE WHEN $3 = '' THEN '{}'::text[] ELSE ARRAY[$3]::text[] END
      FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE c.id = $1
    ON CONFLICT (bot_channel_user_id) DO UPDATE SET
      source = COALESCE(crm_contact.source, EXCLUDED.source),
      tags = CASE WHEN $3 = '' OR $3 = ANY(crm_contact.tags) THEN crm_contact.tags ELSE array_append(crm_contact.tags, $3) END,
      updated_at = NOW()`, [conversationId, source, clean]).catch(() => undefined);
}

async function campaignTag(ds: DataSource, campaignId: number | null): Promise<string> {
  if (!campaignId) return '';
  const [row] = await ds.query(`SELECT tag, name FROM marketing_campaign WHERE id = $1`, [campaignId]);
  return row ? String(row.tag || '') : '';
}

/** Short link: "#slug" in the message (WhatsApp) or the ready text itself. Returns true when linked. */
export async function attributeText(ds: DataSource, conversationId: number, companyId: number, text: string): Promise<boolean> {
  const tags = linkTags(text);
  let found: { id: number; campaign_id: number | null; tag: string } | undefined;
  if (tags.length) {
    [found] = await ds.query(`SELECT id, campaign_id, tag FROM marketing_link WHERE company_id = $1 AND slug = ANY($2::text[]) AND is_active ORDER BY id DESC LIMIT 1`, [companyId, tags]);
  }
  if (!found) {
    // the customer removed "#slug" but kept the ready text
    const clean = normaliseText(text);
    if (clean.length >= 8) {
      const rows: Array<{ id: number; campaign_id: number | null; tag: string; prefill_text: string }> = await ds.query(
        `SELECT id, campaign_id, tag, prefill_text FROM marketing_link WHERE company_id = $1 AND is_active AND channel = 'whatsapp' AND prefill_text <> '' ORDER BY id DESC LIMIT 200`, [companyId]);
      found = rows.find((row) => normaliseText(row.prefill_text) === clean);
    }
  }
  if (!found) return false;
  await link(ds, conversationId, { campaignId: found.campaign_id ? Number(found.campaign_id) : null, source: 'link', linkId: Number(found.id) });
  await tagContact(ds, conversationId, 'link', found.tag || (await campaignTag(ds, found.campaign_id)));
  return true;
}

/** Messenger / Instagram short link: m.me/PAGE?ref=slug sends the slug as "ref". */
export async function attributeRef(ds: DataSource, conversationId: number, companyId: number, ref: string): Promise<boolean> {
  const slug = String(ref ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return false;
  const [found] = await ds.query(`SELECT id, campaign_id, tag FROM marketing_link WHERE company_id = $1 AND slug = $2 AND is_active`, [companyId, slug]);
  if (!found) return false;
  await link(ds, conversationId, { campaignId: found.campaign_id ? Number(found.campaign_id) : null, source: 'link', linkId: Number(found.id) });
  await tagContact(ds, conversationId, 'link', found.tag || (await campaignTag(ds, found.campaign_id)));
  return true;
}

/** Meta ad: the campaign that lists this ad id, or the ad's Meta campaign id. */
export async function attributeAd(ds: DataSource, conversationId: number, companyId: number, adId: string): Promise<boolean> {
  const [cache] = await ds.query(`SELECT campaign_id FROM marketing_ad_cache WHERE ad_id = $1`, [adId]);
  const metaCampaignId = cache?.campaign_id ? String(cache.campaign_id) : null;
  const [found] = await ds.query(`
    SELECT id, tag FROM marketing_campaign
     WHERE company_id = $1 AND status = 'active'
       AND (meta_ad_ids ? $2 OR ($3::text IS NOT NULL AND meta_campaign_ids ? $3))
       AND (starts_at IS NULL OR starts_at <= $4::date) AND (ends_at IS NULL OR ends_at >= $4::date)
     ORDER BY id DESC LIMIT 1`, [companyId, adId, metaCampaignId, sriLankaToday()]);
  if (!found) {
    // still mark the source (the bot gets the ad text), without a campaign
    await ds.query(`UPDATE bot_conversation SET campaign_id = NULL, campaign_source = 'ad', campaign_at = NOW() WHERE id = $1`, [conversationId]);
    return false;
  }
  await link(ds, conversationId, { campaignId: Number(found.id), source: 'ad' });
  await tagContact(ds, conversationId, 'ad', found.tag);
  return true;
}

/** A reply within 7 days to a broadcast of a campaign (when nothing newer is linked). */
export async function attributeBroadcastReply(ds: DataSource, conversationId: number): Promise<boolean> {
  const [row] = await ds.query(`
    SELECT b.campaign_id FROM bot_conversation c
      JOIN marketing_broadcast_recipient r ON r.bot_channel_user_id = c.bot_channel_user_id AND r.status = 'sent'
      JOIN marketing_broadcast b ON b.id = r.broadcast_id AND b.campaign_id IS NOT NULL
     WHERE c.id = $1 AND r.sent_at > NOW() - make_interval(days => $2::int)
       AND (c.campaign_at IS NULL OR c.campaign_at < r.sent_at)
     ORDER BY r.sent_at DESC LIMIT 1`, [conversationId, CAMPAIGN_DAYS]);
  if (!row?.campaign_id) return false;
  await link(ds, conversationId, { campaignId: Number(row.campaign_id), source: 'broadcast' });
  await tagContact(ds, conversationId, 'broadcast', await campaignTag(ds, Number(row.campaign_id)));
  return true;
}

export type BotCampaign = {
  source: Source;
  name: string;
  ad_headline: string;
  ad_body: string;
  offer: string;
  instructions: string;
  product_ids: number[];
  ends_at: string | null;
};

/** What the AI should know about where this customer came from (null = nothing recent). */
export async function campaignForBot(ds: DataSource, conversationId: number): Promise<BotCampaign | null> {
  const [row] = await ds.query(`
    SELECT c.campaign_source, c.campaign_at, c.ad_headline, c.ad_body, c.ad_referred_at,
           mc.name, mc.offer_text, mc.bot_instructions, mc.product_ids, mc.ends_at::text AS ends_at, mc.status,
           l.name AS link_name, ac.campaign_name AS meta_campaign_name
      FROM bot_conversation c
      LEFT JOIN marketing_campaign mc ON mc.id = c.campaign_id
      LEFT JOIN marketing_link l ON l.id = c.link_id
      LEFT JOIN marketing_ad_cache ac ON ac.ad_id = c.ad_source_id
     WHERE c.id = $1 AND c.campaign_at > NOW() - make_interval(days => $2::int)`, [conversationId, CAMPAIGN_DAYS]);
  if (!row?.campaign_source) return null;
  const source = row.campaign_source as Source;
  const ended = Boolean(row.ends_at) && String(row.ends_at).slice(0, 10) < sriLankaToday();
  const active = row.name && row.status === 'active' && !ended;
  const fromAd = source === 'ad';
  if (!active && source === 'link' && row.link_name) {
    // a short link without a (running) campaign: the bot still knows where the customer came from
    return { source, name: String(row.link_name), ad_headline: '', ad_body: '', offer: '', instructions: '', product_ids: [], ends_at: null };
  }
  if (!active && !fromAd) return null;
  return {
    source,
    name: active ? String(row.name) : String(row.meta_campaign_name ?? ''),
    ad_headline: fromAd ? String(row.ad_headline ?? '').slice(0, 300) : '',
    ad_body: fromAd ? String(row.ad_body ?? '').slice(0, 600) : '',
    offer: active ? String(row.offer_text ?? '').slice(0, 1000) : '',
    instructions: active ? String(row.bot_instructions ?? '').slice(0, 1500) : '',
    product_ids: active && Array.isArray(row.product_ids) ? row.product_ids.map(Number).filter(Number.isFinite).slice(0, 20) : [],
    ends_at: active && row.ends_at ? String(row.ends_at).slice(0, 10) : null,
  };
}

/* ───── Messenger / Instagram: a ref or ad that arrives before the chat exists ───── */

export type PendingRef = { kind: 'ad' | 'ref'; value: string; headline?: string; body?: string; url?: string };

/** Kept for 30 minutes and used when the customer's first message creates the chat. */
export async function savePendingRef(ds: DataSource, platform: string, externalUserId: string, ref: PendingRef) {
  await ds.query(`INSERT INTO marketing_pending_ref (platform, external_user_id, data) VALUES ($1, $2, $3::jsonb)`,
    [platform, externalUserId, JSON.stringify(ref)]);
  await ds.query(`DELETE FROM marketing_pending_ref WHERE created_at < NOW() - INTERVAL '30 minutes'`).catch(() => undefined);
}

/** Applies (and removes) waiting refs for the customer of this chat. */
export async function applyPendingRefs(ds: DataSource, conversationId: number): Promise<boolean> {
  const rows: Array<{ id: number; data: PendingRef; company_id: number }> = await ds.query(`
    SELECT p.id, p.data, cu.company_id FROM bot_conversation c
      JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
      JOIN marketing_pending_ref p ON p.platform = cu.platform AND p.external_user_id = cu.external_user_id
     WHERE c.id = $1 AND p.created_at > NOW() - INTERVAL '30 minutes' ORDER BY p.id`, [conversationId]);
  if (!rows.length) return false;
  await ds.query(`DELETE FROM marketing_pending_ref WHERE id = ANY($1::bigint[])`, [rows.map((row) => row.id)]);
  let linked = false;
  for (const row of rows) {
    const ref = row.data;
    if (ref.kind === 'ref') linked = (await attributeRef(ds, conversationId, Number(row.company_id), ref.value)) || linked;
    else {
      await ds.query(`UPDATE bot_conversation SET ad_source_id = $2, ad_source_type = 'ad', ad_headline = $3, ad_body = $4, ad_source_url = $5, ad_referred_at = NOW() WHERE id = $1`,
        [conversationId, ref.value, String(ref.headline ?? '').slice(0, 1000), String(ref.body ?? '').slice(0, 2000), String(ref.url ?? '').slice(0, 1000)]);
      await attributeAd(ds, conversationId, Number(row.company_id), ref.value);
      linked = true;
    }
  }
  return linked;
}
