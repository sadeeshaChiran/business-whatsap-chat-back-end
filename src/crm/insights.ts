import { BadRequestException, Body, Controller, Get, Injectable, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerOnly } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { FeatureGuard, RequiresFeature } from '../platform/feature.guard';

/**
 * Customer insights: every customer's VISITS (each time they came – first message, an ad click, or writing again after
 * 3+ days of silence) with the result of each visit (ordered, booked, won, lost, still talking …), then customers grouped
 * by their history: loyal buyers, repeat buyers who did not buy last time, lost again and again, in talks now …
 * Works for WhatsApp, Messenger and Instagram (one person on two channels counts as two customers).
 */
export const RETURN_GAP_HOURS = 72;
export const PENDING_DAYS = 7;
const VISIT_DAYS = 28;
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export type VisitOutcome = 'ordered' | 'booked' | 'won' | 'lost' | 'interested' | 'talking' | 'no_answer';
export type VisitResult = 'won' | 'lost' | 'open';
export type SegmentKey = 'pending' | 'loyal' | 'slipping' | 'one_time' | 'lapsed' | 'lost_repeat' | 'lost_once' | 'browsers' | 'quiet';

export const SEGMENTS: Array<{ key: SegmentKey; label: string; description: string; action: string; tone: string }> = [
  { key: 'pending', label: 'In talks now', description: 'Their latest visit is still open (last message in the last 7 days) – no order and no "no" yet.', action: 'Answer quickly and follow up today – these are your next sales.', tone: 'sky' },
  { key: 'loyal', label: 'Loyal buyers', description: 'Bought in 2 or more visits, and bought again last time.', action: 'Thank them, give a VIP / loyalty offer, ask for a review or a referral.', tone: 'emerald' },
  { key: 'slipping', label: 'Repeat buyers – no order last time', description: 'Bought in 2 or more visits, but the last visit ended without an order.', action: 'Ask what went wrong, send a personal come-back offer. They know you – they are easy to win back.', tone: 'amber' },
  { key: 'one_time', label: 'Bought once (last visit)', description: 'One purchase, in their latest visit.', action: 'Follow up after delivery and suggest a second product – turn them into repeat buyers.', tone: 'teal' },
  { key: 'lapsed', label: 'Bought before – not this time', description: 'Bought once in an earlier visit; came back but did not buy.', action: 'Find out why (price, stock, delivery) and send a come-back offer.', tone: 'orange' },
  { key: 'lost_repeat', label: 'Lost again and again', description: 'Said no / were lost in 2 or more visits and never bought.', action: 'Check the reasons in the chats – price, delivery fee or the bot\'s answers. Try one strong offer, then stop spending on them.', tone: 'rose' },
  { key: 'lost_once', label: 'Lost once', description: 'Lost in one visit and never bought.', action: 'A short, friendly offer later can still win them.', tone: 'pink' },
  { key: 'browsers', label: 'Came many times, never bought', description: '2 or more visits, no order and no clear "no".', action: 'They are interested – ask what stops them, offer cash on delivery or a small first-order discount.', tone: 'violet' },
  { key: 'quiet', label: 'Went quiet', description: 'One visit, no order, and no reply for more than 7 days.', action: 'One follow-up template / broadcast, then let them be.', tone: 'slate' },
];

export class InsightsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(3650) days?: number;
  @IsOptional() @IsIn(['whatsapp', 'messenger', 'instagram', 'tiktok', 'telegram', 'app']) platform?: 'whatsapp' | 'messenger' | 'instagram' | 'tiktok' | 'telegram' | 'app';
}
export class InsightsTagDto extends InsightsQueryDto {
  @IsIn(SEGMENTS.map((s) => s.key)) segment!: SegmentKey;
  @IsString() @MaxLength(40) @Matches(/\S/) tag!: string;
}

export function visitOutcome(v: Record<string, any>): VisitOutcome {
  if (num(v.orders) > 0) return 'ordered';
  if (num(v.bookings) > 0) return 'booked';
  if (num(v.won_events) > 0) return 'won';
  if (num(v.lost_events) > 0 || num(v.cancelled_orders) > 0) return 'lost';
  if (num(v.interested_events) > 0 || (v.is_last && ['qualified', 'proposal'].includes(String(v.lead_stage)))) return 'interested';
  return v.replied ? 'talking' : 'no_answer';
}
export const resultOf = (o: VisitOutcome): VisitResult => (o === 'ordered' || o === 'booked' || o === 'won' ? 'won' : o === 'lost' ? 'lost' : 'open');

export function segmentOf(c: { wins: number; losses: number; visits: number; pending: boolean; last_result: VisitResult }): SegmentKey {
  if (c.pending) return 'pending';
  if (c.wins >= 2) return c.last_result === 'won' ? 'loyal' : 'slipping';
  if (c.wins === 1) return c.last_result === 'won' ? 'one_time' : 'lapsed';
  if (c.losses >= 2) return 'lost_repeat';
  if (c.losses === 1) return 'lost_once';
  return c.visits >= 2 ? 'browsers' : 'quiet';
}

@Injectable()
export class CustomerInsightsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private companyId(user: AuthenticatedUser) {
    const id = Number(user.company_id);
    if (!id) throw new BadRequestException('No company.');
    return id;
  }

  /** Every visit of every customer of the company (all time). */
  async visits(companyId: number, platform: string | null) {
    return this.dataSource.query(`
      WITH u AS (
        SELECT cu.id FROM bot_channel_user cu WHERE cu.company_id = $1 AND ($2::text IS NULL OR cu.platform = $2)
      ),
      inb AS (
        SELECT c.bot_channel_user_id AS uid, m.created_at::timestamptz AS at,
               LAG(m.created_at::timestamptz) OVER (PARTITION BY c.bot_channel_user_id ORDER BY m.created_at) AS prev
          FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id JOIN u ON u.id = c.bot_channel_user_id
         WHERE m.direction::text = 'inbound'
      ),
      starts AS (
        SELECT uid, at, FALSE AS ad, NULL::text AS ad_id FROM inb WHERE prev IS NULL OR at - prev > make_interval(hours => $3::int)
        UNION ALL
        SELECT k.bot_channel_user_id, k.clicked_at, TRUE, k.ad_id FROM marketing_ad_click k JOIN u ON u.id = k.bot_channel_user_id
      ),
      s1 AS (SELECT s.*, LAG(at) OVER (PARTITION BY uid ORDER BY at, ad DESC) AS p FROM starts s),
      s2 AS (SELECT s1.*, SUM(CASE WHEN p IS NULL OR at - p > INTERVAL '30 minutes' THEN 1 ELSE 0 END)
                            OVER (PARTITION BY uid ORDER BY at, ad DESC ROWS UNBOUNDED PRECEDING) AS grp FROM s1),
      v0 AS (
        SELECT uid, grp, MIN(at) AS start_at, BOOL_OR(ad) AS from_ad,
               (ARRAY_AGG(ad_id ORDER BY at DESC) FILTER (WHERE ad_id IS NOT NULL))[1] AS ad_id
          FROM s2 GROUP BY uid, grp
      ),
      v AS (
        SELECT v0.*, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY start_at) AS n,
               LEAD(start_at) OVER (PARTITION BY uid ORDER BY start_at) AS next_at
          FROM v0
      ),
      w AS (
        SELECT v.*, v.start_at - INTERVAL '1 minute' AS ws,
               LEAST(COALESCE(v.next_at, 'infinity'::timestamptz), v.start_at + make_interval(days => $4::int)) AS we,
               v.next_at IS NULL AS is_last
          FROM v
      )
      SELECT w.uid, w.n::int, w.start_at, w.we AS end_at, w.is_last, w.from_ad, w.ad_id,
             ad.headline AS ad_headline, ad.source_type AS ad_type,
             (SELECT c.lead_stage FROM bot_conversation c WHERE c.bot_channel_user_id = w.uid ORDER BY c.id DESC LIMIT 1) AS lead_stage,
             (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = w.uid AND o.status::text <> 'Cancelled' AND o.created_at >= w.ws AND o.created_at < w.we)::int AS orders,
             (SELECT COALESCE(SUM(o.total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = w.uid AND o.status::text <> 'Cancelled' AND o.created_at >= w.ws AND o.created_at < w.we) AS revenue,
             (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = w.uid AND o.status::text = 'Cancelled' AND o.created_at >= w.ws AND o.created_at < w.we)::int AS cancelled_orders,
             (SELECT COUNT(*) FROM bot_booking b WHERE b.bot_channel_user_id = w.uid AND LOWER(b.status) NOT IN ('cancelled', 'rejected') AND b.created_at >= w.ws AND b.created_at < w.we)::int AS bookings,
             (SELECT COUNT(*) FROM lead_stage_event e WHERE e.bot_channel_user_id = w.uid AND e.to_stage = 'won' AND e.changed_at >= w.ws AND e.changed_at < w.we)::int AS won_events,
             (SELECT COUNT(*) FROM lead_stage_event e WHERE e.bot_channel_user_id = w.uid AND e.to_stage = 'lost' AND e.changed_at >= w.ws AND e.changed_at < w.we)::int AS lost_events,
             (SELECT COUNT(*) FROM lead_stage_event e WHERE e.bot_channel_user_id = w.uid AND e.to_stage IN ('qualified', 'proposal') AND e.changed_at >= w.ws AND e.changed_at < w.we)::int AS interested_events,
             EXISTS (SELECT 1 FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
                      WHERE c.bot_channel_user_id = w.uid AND m.direction::text = 'outbound' AND m.created_at >= w.start_at AND m.created_at < w.we) AS replied,
             (SELECT MAX(m.created_at) FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
               WHERE c.bot_channel_user_id = w.uid AND m.direction::text = 'inbound' AND m.created_at >= w.ws AND m.created_at < w.we) AS last_message_at
        FROM w
        LEFT JOIN LATERAL (SELECT k.headline, k.source_type FROM marketing_ad_click k WHERE k.bot_channel_user_id = w.uid AND k.ad_id = w.ad_id
                            ORDER BY k.clicked_at DESC LIMIT 1) ad ON w.ad_id IS NOT NULL
       ORDER BY w.uid, w.start_at`, [companyId, platform, RETURN_GAP_HOURS, VISIT_DAYS]) as Promise<Array<Record<string, any>>>;
  }

  async report(user: AuthenticatedUser, query: InsightsQueryDto) {
    const companyId = this.companyId(user);
    const days = query.days ?? 365;
    const platform = query.platform ?? null;
    const rows = await this.visits(companyId, platform);
    const since = Date.now() - days * 86_400_000;
    const byUser = new Map<number, Array<Record<string, any>>>();
    for (const row of rows) {
      const list = byUser.get(Number(row.uid)) ?? [];
      list.push(row);
      byUser.set(Number(row.uid), list);
    }
    const ids = [...byUser.keys()];
    const people: Array<Record<string, any>> = ids.length ? await this.dataSource.query(`
      SELECT cu.id, cu.platform, cu.display_name, cu.external_user_id, cc.phone, COALESCE(cc.tags, '{}') AS tags,
             (SELECT c.id FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
       WHERE cu.company_id = $1 AND cu.id = ANY($2::int[])`, [companyId, ids]) : [];
    const info = new Map(people.map((p) => [Number(p.id), p]));

    const customers = [] as Array<ReturnType<typeof build>>;
    function build(uid: number, list: Array<Record<string, any>>) {
      const p = info.get(uid) ?? {};
      const visits = list.map((v) => {
        const outcome = visitOutcome(v);
        return {
          n: num(v.n), start_at: v.start_at, from_ad: Boolean(v.from_ad), ad_id: v.ad_id ?? null, ad_headline: v.ad_headline ?? null,
          ad_type: v.ad_type === 'post' || v.ad_type === 'card' ? v.ad_type : v.ad_id ? 'ad' : null, outcome, result: resultOf(outcome),
          orders: num(v.orders), bookings: num(v.bookings), revenue: num(v.revenue), last_message_at: v.last_message_at ?? null,
        };
      });
      const last = visits[visits.length - 1];
      const lastRow = list[list.length - 1];
      const lastActivity = new Date(lastRow.last_message_at ?? lastRow.start_at).getTime();
      const pending = last.result === 'open' && Date.now() - lastActivity < PENDING_DAYS * 86_400_000;
      const wins = visits.filter((v) => v.result === 'won').length;
      const losses = visits.filter((v) => v.result === 'lost').length;
      const summary = { wins, losses, visits: visits.length, pending, last_result: last.result };
      return {
        id: uid, platform: p.platform ?? null, name: p.display_name || null, external_user_id: p.external_user_id ?? null, phone: p.phone ?? null,
        tags: (p.tags as string[] | undefined) ?? [], conversation_id: p.conversation_id ? Number(p.conversation_id) : null,
        ...summary, open: visits.filter((v) => v.result === 'open').length,
        orders: visits.reduce((s, v) => s + v.orders, 0), bookings: visits.reduce((s, v) => s + v.bookings, 0),
        revenue: visits.reduce((s, v) => s + v.revenue, 0), ad_visits: visits.filter((v) => v.from_ad).length,
        first_seen: visits[0].start_at, last_visit_at: last.start_at, last_activity_at: new Date(lastActivity).toISOString(),
        last_outcome: last.outcome, segment: segmentOf(summary), win_rate: Math.round((wins / visits.length) * 100),
        history: visits.slice(-12).reverse(),
        all: visits,
      };
    }
    for (const [uid, list] of byUser) {
      const lastStart = new Date(list[list.length - 1].start_at).getTime();
      if (lastStart < since) continue; // not active in the period
      customers.push(build(uid, list));
    }
    customers.sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime());

    // TikTok shows up only for a business that has TikTok customers (nothing changes for the others)
    const platforms: string[] = ['whatsapp', 'messenger', 'instagram', ...(['tiktok', 'telegram', 'app'] as const).filter((pf) => customers.some((c) => c.platform === pf))];
    const visitsInPeriod = customers.flatMap((c) => c.all.filter((v) => new Date(v.start_at).getTime() >= since).map((v) => ({ ...v, platform: c.platform })));
    const channelRow = (pf: string | null) => {
      const list = pf ? customers.filter((c) => c.platform === pf) : customers;
      const vs = pf ? visitsInPeriod.filter((v) => v.platform === pf) : visitsInPeriod;
      const won = vs.filter((v) => v.result === 'won').length;
      return {
        platform: pf ?? 'all', customers: list.length, buyers: list.filter((c) => c.wins > 0).length, repeat_buyers: list.filter((c) => c.wins >= 2).length,
        visits: vs.length, won_visits: won, lost_visits: vs.filter((v) => v.result === 'lost').length, open_visits: vs.filter((v) => v.result === 'open').length,
        pending: list.filter((c) => c.pending).length, revenue: vs.reduce((s, v) => s + v.revenue, 0),
        win_rate: vs.length ? Math.round((won / vs.length) * 1000) / 10 : 0,
        ad_visits: vs.filter((v) => v.from_ad).length, ad_won: vs.filter((v) => v.from_ad && v.result === 'won').length,
      };
    };
    const segments = SEGMENTS.map((s) => {
      const list = customers.filter((c) => c.segment === s.key);
      return {
        ...s, count: list.length, share: customers.length ? Math.round((list.length / customers.length) * 1000) / 10 : 0,
        revenue: list.reduce((sum, c) => sum + c.revenue, 0),
        by_platform: Object.fromEntries(platforms.map((pf) => [pf, list.filter((c) => c.platform === pf).length])),
      };
    });
    const totals = channelRow(null);
    return {
      days, platform: platform ?? 'all', return_gap_hours: RETURN_GAP_HOURS, pending_days: PENDING_DAYS,
      totals: { ...totals, lost_customers: customers.filter((c) => c.losses > 0 && c.wins === 0).length },
      channels: platforms.map((pf) => channelRow(pf)).filter((row) => !platform || row.platform === platform),
      segments,
      assessment: assess(totals, segments, platforms.map((pf) => channelRow(pf)), customers.length),
      customers: customers.slice(0, 3000).map(({ all: _all, ...c }) => c),
      truncated: customers.length > 3000,
    };
  }

  /** Adds a tag to every customer of a group (for broadcasts, audiences and filters). */
  async tagSegment(user: AuthenticatedUser, dto: InsightsTagDto) {
    const companyId = this.companyId(user);
    const report = await this.report(user, dto);
    const tag = dto.tag.trim().toLowerCase();
    const ids = report.customers.filter((c) => c.segment === dto.segment).map((c) => c.id);
    if (!ids.length) return { tagged: 0, tag };
    await this.dataSource.query(`
      INSERT INTO crm_contact (bot_channel_user_id, company_id) SELECT UNNEST($1::int[]), $2 ON CONFLICT (bot_channel_user_id) DO NOTHING`, [ids, companyId]);
    await this.dataSource.query(`
      UPDATE crm_contact SET tags = ARRAY(SELECT DISTINCT t FROM UNNEST(COALESCE(tags, '{}') || ARRAY[$2]::text[]) AS t), updated_at = NOW()
       WHERE company_id = $3 AND bot_channel_user_id = ANY($1::int[])`, [ids, tag, companyId]);
    return { tagged: ids.length, tag };
  }
}

/** Plain-language findings for the owner. */
function assess(totals: Record<string, number | string>, segments: Array<{ key: SegmentKey; label: string; count: number; revenue: number }>,
  channels: Array<Record<string, number | string>>, customers: number): string[] {
  if (!customers) return ['No customer visits in this period yet.'];
  const seg = (key: SegmentKey) => segments.find((s) => s.key === key)?.count ?? 0;
  const out: string[] = [];
  const buyers = num(totals.buyers);
  out.push(`${customers} customers came in this period; ${buyers} of them bought (${Math.round((buyers / customers) * 100)}%). ${num(totals.won_visits)} of ${num(totals.visits)} visits ended in a sale (${totals.win_rate}%).`);
  if (buyers) out.push(`${num(totals.repeat_buyers)} buyers bought more than once (${Math.round((num(totals.repeat_buyers) / buyers) * 100)}% of buyers).`);
  if (seg('pending')) out.push(`${seg('pending')} customers are in talks right now – the quickest sales to close.`);
  const back = seg('slipping') + seg('lapsed');
  if (back) out.push(`${back} customers bought before but did not buy on their last visit – a personal come-back offer usually works best here.`);
  if (seg('lost_repeat')) out.push(`${seg('lost_repeat')} customers were lost again and again without buying – read a few of their chats to find the common reason.`);
  if (seg('browsers')) out.push(`${seg('browsers')} customers came several times but never bought – they are interested; a first-order offer can convert them.`);
  const active = channels.filter((c) => num(c.visits) >= 5);
  if (active.length >= 2) {
    const best = [...active].sort((a, b) => num(b.win_rate) - num(a.win_rate));
    out.push(`Best channel: ${String(best[0].platform)} (${best[0].win_rate}% of visits buy) – weakest: ${String(best[best.length - 1].platform)} (${best[best.length - 1].win_rate}%).`);
  }
  if (num(totals.ad_visits)) out.push(`${num(totals.ad_visits)} visits came from ads; ${num(totals.ad_won)} of them ended in a sale (${Math.round((num(totals.ad_won) / num(totals.ad_visits)) * 100)}%).`);
  return out;
}

@Controller('crm/insights')
@ApiTags('CRM')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequiresFeature('crm')
export class CustomerInsightsController {
  constructor(private readonly insights: CustomerInsightsService) {}

  @Get()
  @ManagerOnly()
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: InsightsQueryDto) { return this.insights.report(user, query); }

  @Post('tag')
  @ManagerOnly()
  tag(@CurrentUser() user: AuthenticatedUser, @Body() dto: InsightsTagDto) { return this.insights.tagSegment(user, dto); }
}
