import type { DataSource } from 'typeorm';
import { graphRequest } from './graph';

/**
 * Ad-by-ad results from our own chats: every ad / shared post that opened a chat (marketing_ad_click), the people it brought,
 * whether they got an answer, became interested, ordered, booked or were lost – plus Meta's spend for the ad when the ad
 * account is connected. Orders and bookings count for 28 days after the person's last click on that ad.
 */
export const ATTRIBUTION_DAYS = 28;
const num = (value: unknown) => Number(value ?? 0) || 0;
type Meta = { token: string } | null;

export type AdRow = {
  ad_id: string; type: 'ad' | 'post'; headline: string | null; body: string | null; url: string | null; media_url: string | null; platforms: string[];
  ad_name: string | null; campaign_id: string | null; campaign_name: string | null;
  clicks: number; people: number; new_contacts: number; replied: number; interested: number; won: number; lost: number; no_answer: number;
  orders: number; bookings: number; revenue: number; first_click: string; last_click: string;
  spend: number | null; impressions: number | null; link_clicks: number | null; conversations_started: number | null;
  cost_per_person: number | null; cost_per_win: number | null; roas: number | null; conversion_rate: number;
};

/** People per ad with their outcome (shared by the list and the ad page). */
function peopleSql(filterAd: boolean) {
  return `
    WITH k AS (
      SELECT * FROM marketing_ad_click
       WHERE company_id = $1 AND clicked_at > NOW() - make_interval(days => $2::int) ${filterAd ? 'AND ad_id = $4' : ''}
    ),
    people AS (
      SELECT ad_id, bot_channel_user_id, MIN(clicked_at) AS first_click, MAX(clicked_at) AS last_click, COUNT(*)::int AS clicks,
             (ARRAY_AGG(conversation_id ORDER BY clicked_at DESC))[1] AS conversation_id, (ARRAY_AGG(platform ORDER BY clicked_at DESC))[1] AS platform
        FROM k GROUP BY ad_id, bot_channel_user_id
    )
    SELECT p.*, cu.display_name, cu.external_user_id, COALESCE(c.lead_stage, 'new') AS lead_stage,
           cu.created_at >= p.first_click - INTERVAL '10 minutes' AS new_contact,
           EXISTS (SELECT 1 FROM bot_message m WHERE m.conversation_id = p.conversation_id AND m.direction::text = 'outbound' AND m.created_at >= p.first_click) AS replied,
           (SELECT MAX(m.created_at) FROM bot_message m WHERE m.conversation_id = p.conversation_id) AS last_message_at,
           (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = p.bot_channel_user_id AND o.status::text <> 'Cancelled'
              AND o.created_at >= p.first_click AND o.created_at < p.last_click + make_interval(days => $3::int))::int AS orders,
           (SELECT COALESCE(SUM(o.total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = p.bot_channel_user_id AND o.status::text <> 'Cancelled'
              AND o.created_at >= p.first_click AND o.created_at < p.last_click + make_interval(days => $3::int)) AS revenue,
           (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = p.bot_channel_user_id AND o.status::text = 'Cancelled'
              AND o.created_at >= p.first_click AND o.created_at < p.last_click + make_interval(days => $3::int))::int AS cancelled_orders,
           (SELECT COUNT(*) FROM bot_booking b WHERE b.bot_channel_user_id = p.bot_channel_user_id AND LOWER(b.status) NOT IN ('cancelled', 'rejected')
              AND b.created_at >= p.first_click AND b.created_at < p.last_click + make_interval(days => $3::int))::int AS bookings
      FROM people p
      LEFT JOIN bot_channel_user cu ON cu.id = p.bot_channel_user_id
      LEFT JOIN bot_conversation c ON c.id = p.conversation_id`;
}

export type Outcome = 'ordered' | 'booked' | 'won' | 'lost' | 'interested' | 'talking' | 'no_answer';
export function outcomeOf(row: Record<string, any>): Outcome {
  if (num(row.orders) > 0) return 'ordered';
  if (num(row.bookings) > 0) return 'booked';
  if (row.lead_stage === 'won') return 'won';
  if (row.lead_stage === 'lost' || num(row.cancelled_orders) > 0) return 'lost';
  if (row.lead_stage === 'qualified' || row.lead_stage === 'proposal') return 'interested';
  return row.replied ? 'talking' : 'no_answer';
}
const isWin = (o: Outcome) => o === 'ordered' || o === 'booked' || o === 'won';

/** Meta numbers for these ads (works across ad accounts the login can see). Empty when not connected or Meta refuses. */
async function metaForAds(meta: Meta, adIds: string[], days: number) {
  const out = new Map<string, { name?: string; spend: number; impressions: number; link_clicks: number; conversations_started: number; thumbnail?: string | null }>();
  const ids = adIds.filter((id) => /^\d+$/.test(id)).slice(0, 50);
  if (!meta?.token || !ids.length) return out;
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);
  const range = JSON.stringify({ since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) });
  try {
    const result = await graphRequest<Record<string, { id: string; name?: string; creative?: { thumbnail_url?: string }; insights?: { data?: Array<Record<string, any>> } }>>(
      'GET', '/', meta.token, { ids: ids.join(','), fields: `name,creative{thumbnail_url},insights.time_range(${range}){spend,impressions,inline_link_clicks,actions}` });
    for (const ad of Object.values(result)) {
      const i = ad.insights?.data?.[0] ?? {};
      const actions = (i.actions as Array<{ action_type: string; value: string }> | undefined) ?? [];
      const started = Math.max(0, ...actions.filter((a) => /messaging_conversation_started|onsite_conversion\.messaging_first_reply|total_messaging_connection/.test(a.action_type)).map((a) => num(a.value)));
      out.set(String(ad.id), { name: ad.name, spend: num(i.spend), impressions: num(i.impressions), link_clicks: num(i.inline_link_clicks), conversations_started: started, thumbnail: ad.creative?.thumbnail_url ?? null });
    }
  } catch { /* not this login's ad (or no permission): our own numbers still show */ }
  return out;
}

export async function adsReport(ds: DataSource, companyId: number, days: number, meta: Meta) {
  const people: Array<Record<string, any>> = await ds.query(peopleSql(false), [companyId, days, ATTRIBUTION_DAYS]);
  const latest: Array<Record<string, any>> = await ds.query(`
    SELECT DISTINCT ON (k.ad_id) k.ad_id, k.source_type, k.headline, k.body, k.url, k.media_url,
           (SELECT ARRAY_AGG(DISTINCT x.platform) FROM marketing_ad_click x WHERE x.company_id = $1 AND x.ad_id = k.ad_id) AS platforms,
           (SELECT COUNT(*) FROM marketing_ad_click x WHERE x.company_id = $1 AND x.ad_id = k.ad_id AND x.clicked_at > NOW() - make_interval(days => $2::int))::int AS clicks,
           m.ad_name, m.campaign_id, m.campaign_name
      FROM marketing_ad_click k LEFT JOIN marketing_ad_cache m ON m.ad_id = k.ad_id
     WHERE k.company_id = $1 AND k.clicked_at > NOW() - make_interval(days => $2::int)
     ORDER BY k.ad_id, k.clicked_at DESC`, [companyId, days]);
  const metaById = await metaForAds(meta, latest.map((r) => String(r.ad_id)), days);
  const rows: AdRow[] = latest.map((ad) => {
    const mine = people.filter((p) => p.ad_id === ad.ad_id);
    const outcomes = mine.map(outcomeOf);
    const m = metaById.get(String(ad.ad_id));
    const revenue = mine.reduce((s, p) => s + num(p.revenue), 0);
    const won = outcomes.filter(isWin).length;
    const spend = m ? m.spend : null;
    return {
      ad_id: String(ad.ad_id), type: (ad.source_type === 'post' ? 'post' : 'ad') as AdRow['type'], headline: ad.headline || null, body: ad.body || null, url: ad.url || null,
      media_url: ad.media_url || m?.thumbnail || null, platforms: (ad.platforms ?? []).filter(Boolean),
      ad_name: ad.ad_name || m?.name || null, campaign_id: ad.campaign_id || null, campaign_name: ad.campaign_name || null,
      clicks: num(ad.clicks), people: mine.length, new_contacts: mine.filter((p) => p.new_contact).length, replied: mine.filter((p) => p.replied).length,
      interested: outcomes.filter((o) => o === 'interested').length, won, lost: outcomes.filter((o) => o === 'lost').length,
      no_answer: outcomes.filter((o) => o === 'no_answer').length,
      orders: mine.reduce((s, p) => s + num(p.orders), 0), bookings: mine.reduce((s, p) => s + num(p.bookings), 0), revenue,
      first_click: new Date(Math.min(...mine.map((p) => new Date(p.first_click).getTime()))).toISOString(),
      last_click: new Date(Math.max(...mine.map((p) => new Date(p.last_click).getTime()))).toISOString(),
      spend, impressions: m ? m.impressions : null, link_clicks: m ? m.link_clicks : null, conversations_started: m ? m.conversations_started : null,
      cost_per_person: spend != null && mine.length ? spend / mine.length : null, cost_per_win: spend != null && won ? spend / won : null,
      roas: spend ? revenue / spend : null, conversion_rate: mine.length ? Math.round((won / mine.length) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.people - a.people || b.revenue - a.revenue);
  const total = (key: keyof AdRow) => rows.reduce((s, r) => s + num(r[key]), 0);
  const spendKnown = rows.some((r) => r.spend != null);
  const [organic] = await ds.query(`
    SELECT COUNT(*)::int AS chats FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
     WHERE cu.company_id = $1 AND c.ad_source_id IS NULL AND c.created_at > NOW() - make_interval(days => $2::int)`, [companyId, days]);
  return {
    days, attribution_window_days: ATTRIBUTION_DAYS, meta_connected: Boolean(meta?.token),
    totals: {
      ads: rows.length, clicks: total('clicks'), people: total('people'), new_contacts: total('new_contacts'), replied: total('replied'),
      interested: total('interested'), won: total('won'), lost: total('lost'), no_answer: total('no_answer'),
      orders: total('orders'), bookings: total('bookings'), revenue: total('revenue'), spend: spendKnown ? total('spend') : null,
      organic_chats: num(organic?.chats),
    },
    ads: rows,
  };
}

export async function adReport(ds: DataSource, companyId: number, adId: string, days: number, meta: Meta) {
  const people: Array<Record<string, any>> = await ds.query(peopleSql(true), [companyId, days, ATTRIBUTION_DAYS, adId]);
  const [ad] = await ds.query(`
    SELECT k.ad_id, k.source_type, k.headline, k.body, k.url, k.media_url, k.media_type, m.ad_name, m.campaign_id, m.campaign_name
      FROM marketing_ad_click k LEFT JOIN marketing_ad_cache m ON m.ad_id = k.ad_id
     WHERE k.company_id = $1 AND k.ad_id = $2 ORDER BY k.clicked_at DESC LIMIT 1`, [companyId, adId]);
  if (!ad) return null;
  const daily: Array<Record<string, any>> = await ds.query(`
    WITH d AS (SELECT generate_series((NOW() AT TIME ZONE 'Asia/Colombo')::date - ($3::int - 1), (NOW() AT TIME ZONE 'Asia/Colombo')::date, INTERVAL '1 day')::date AS day)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
           (SELECT COUNT(*) FROM marketing_ad_click k WHERE k.company_id = $1 AND k.ad_id = $2 AND (k.clicked_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS clicks,
           (SELECT COUNT(DISTINCT k.bot_channel_user_id) FROM marketing_ad_click k WHERE k.company_id = $1 AND k.ad_id = $2 AND (k.clicked_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS people
      FROM d ORDER BY d.day`, [companyId, adId, Math.min(days, 90)]);
  const metaById = await metaForAds(meta, [adId], days);
  const m = metaById.get(adId) ?? null;
  const list = people.map((p) => ({
    contact_user_id: Number(p.bot_channel_user_id), conversation_id: Number(p.conversation_id), name: p.display_name || null, external_user_id: p.external_user_id,
    platform: p.platform, first_click: p.first_click, last_click: p.last_click, clicks: num(p.clicks), new_contact: Boolean(p.new_contact), replied: Boolean(p.replied),
    lead_stage: p.lead_stage, orders: num(p.orders), bookings: num(p.bookings), revenue: num(p.revenue), last_message_at: p.last_message_at, outcome: outcomeOf(p),
  })).sort((a, b) => new Date(b.last_click).getTime() - new Date(a.last_click).getTime());
  const count = (o: Outcome) => list.filter((p) => p.outcome === o).length;
  const won = list.filter((p) => isWin(p.outcome)).length;
  const revenue = list.reduce((s, p) => s + p.revenue, 0);
  return {
    days, attribution_window_days: ATTRIBUTION_DAYS, meta_connected: Boolean(meta?.token),
    ad: {
      id: adId, type: ad.source_type === 'post' ? 'post' : 'ad', headline: ad.headline || null, body: ad.body || null, url: ad.url || null,
      media_url: ad.media_url || m?.thumbnail || null, media_type: ad.media_type || null, ad_name: ad.ad_name || m?.name || null,
      campaign_id: ad.campaign_id || null, campaign_name: ad.campaign_name || null,
    },
    totals: {
      clicks: list.reduce((s, p) => s + p.clicks, 0), people: list.length, new_contacts: list.filter((p) => p.new_contact).length,
      replied: list.filter((p) => p.replied).length, no_answer: count('no_answer'), talking: count('talking'), interested: count('interested'),
      ordered: count('ordered'), booked: count('booked'), won, lost: count('lost'),
      orders: list.reduce((s, p) => s + p.orders, 0), bookings: list.reduce((s, p) => s + p.bookings, 0), revenue,
      spend: m ? m.spend : null, impressions: m ? m.impressions : null, link_clicks: m ? m.link_clicks : null, conversations_started: m ? m.conversations_started : null,
      cost_per_person: m && list.length ? m.spend / list.length : null, cost_per_win: m && won ? m.spend / won : null, roas: m?.spend ? revenue / m.spend : null,
      conversion_rate: list.length ? Math.round((won / list.length) * 1000) / 10 : 0,
    },
    daily,
    people: list,
  };
}

/** Every ad account of the Meta login with campaigns and 30-day spend, to find the one that runs the Page's ads. */
export async function adAccountsSummary(token: string, selected: string | null) {
  const accounts = await graphRequest<{ data: Array<{ id: string; name: string; currency: string; account_status: number; business?: { name?: string } }> }>(
    'GET', '/me/adaccounts', token, { fields: 'id,name,currency,account_status,business{name}', limit: '50' });
  const rows = await Promise.all(accounts.data.slice(0, 25).map(async (a) => {
    const [campaigns, insights] = await Promise.all([
      graphRequest<{ data: Array<{ effective_status?: string }> }>('GET', `/${a.id}/campaigns`, token, { fields: 'effective_status', limit: '200' }).catch(() => ({ data: [] as Array<{ effective_status?: string }> })),
      graphRequest<{ data: Array<{ spend?: string }> }>('GET', `/${a.id}/insights`, token, { date_preset: 'last_30d', fields: 'spend' }).catch(() => ({ data: [] as Array<{ spend?: string }> })),
    ]);
    return {
      id: a.id, name: a.name, currency: a.currency, active: a.account_status === 1, business: a.business?.name ?? null, selected: a.id === selected,
      campaigns: campaigns.data.length, active_campaigns: campaigns.data.filter((c) => c.effective_status === 'ACTIVE').length,
      spend_30d: num(insights.data?.[0]?.spend),
    };
  }));
  return rows.sort((x, y) => Number(y.selected) - Number(x.selected) || y.spend_30d - x.spend_30d || y.campaigns - x.campaigns);
}
