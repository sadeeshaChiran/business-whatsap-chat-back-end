import { PlanService } from '../platform/plan.service';
import { isTestPhone } from '../common/test-phone';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { MarketingHook } from '../common/marketing-hook';
import { buildTemplateComponents, type TemplateInput } from './templates';
import { SAMPLE_TEMPLATES, explainWhatsAppError } from './whatsapp-errors';
import { adAccountsSummary, adReport, adsReport } from './ads-report';
import { applyPendingRefs, attributeAd, attributeBroadcastReply, attributeRef, attributeText, linkTags, recordAdClick, savePendingRef } from './attribution';
import {
  GraphError, adsLoginUrl, exchangeAdsCode, fromMinorUnits, graphRequest, normalisePhone, readAdsState, sha256, toMinorUnits,
} from './graph';

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/** whole-message opt-out words (English, Singlish, Sinhala, Tamil) */
const STOP = /^\s*(stop|unsubscribe|opt[\s-]?out|stop promotions|stop messages|nawaththanna|nawattanna|නවත්වන්න|නතර කරන්න|niruththu|நிறுத்து|நிறுத்தவும்)\s*[.!]*\s*$/iu;
const ATTRIBUTION_DAYS = 28;

/** Meta "actions" → the clicks that mean a customer reached out. */
export function contactActions(actions: unknown) {
  const list = Array.isArray(actions) ? (actions as Array<{ action_type?: string; value?: string }>) : [];
  const sum = (test: (type: string) => boolean) => list.filter((a) => test(String(a.action_type ?? ''))).reduce((n, a) => n + (Number(a.value) || 0), 0);
  // Meta reports the same chat under several names (7d / total); take the largest of them, not the sum
  const max = (types: string[]) => Math.max(0, ...types.map((t) => sum((type) => type === t)));
  return {
    conversations_started: max(['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection', 'messaging_conversation_started_7d']),
    first_replies: max(['onsite_conversion.messaging_first_reply']),
    calls: max(['click_to_call_native_call_placed', 'click_to_call_call_confirm']),
    leads: max(['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped']),
    post_engagement: max(['post_engagement']),
    page_likes: max(['like']),
  };
}

type Settings = {
  company_id: number; meta_user_token: string | null; token_expires_at: Date | null; ad_account_id: string | null;
  ad_account_name: string | null; ad_currency: string | null; dataset_id: string | null; capi_token: string | null;
  capi_enabled: boolean; capi_test_code: string | null;
};
export type Audience = { tags?: string[]; stage?: string; exclude_tags?: string[] };

@Injectable()
export class MarketingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketingService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BotConversation) private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage) private readonly messageRepository: Repository<BotMessage>,
    @Optional() private readonly planService?: PlanService,
  ) {}

  onModuleInit() {
    MarketingHook.register((body, platform) => this.captureReferrals(body, platform));
    this.timer = setInterval(() => void this.tick(), 15_000);
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** The routes are @AdminOnly (any admin of the company, not only the owner). */
  async adminCompany(user: AuthenticatedUser): Promise<number> {
    if (String(user.role ?? '').toLowerCase() === 'agent') throw new ForbiddenException('Only company admins can use the marketing tools.');
    const [row] = await this.dataSource.query(`SELECT id FROM companies WHERE id = $1`, [user.company_id]);
    if (!row) throw new ForbiddenException('Only company admins can use the marketing tools.');
    return Number(row.id);
  }

  async settings(companyId: number): Promise<Settings> {
    const [row] = await this.dataSource.query(`SELECT * FROM marketing_settings WHERE company_id = $1`, [companyId]);
    return row ?? {
      company_id: companyId, meta_user_token: null, token_expires_at: null, ad_account_id: null, ad_account_name: null,
      ad_currency: null, dataset_id: null, capi_token: null, capi_enabled: false, capi_test_code: null,
    };
  }

  private async saveSettings(companyId: number, values: Partial<Settings>) {
    const keys = Object.keys(values);
    await this.dataSource.query(`INSERT INTO marketing_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
    if (!keys.length) return;
    await this.dataSource.query(
      `UPDATE marketing_settings SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE company_id = $1`,
      [companyId, ...keys.map((key) => (values as Record<string, unknown>)[key])]);
  }

  private async adsToken(companyId: number): Promise<{ token: string; account: string; settings: Settings }> {
    const settings = await this.settings(companyId);
    if (!settings.meta_user_token) throw new BadRequestException('Connect your Meta ad account first (Marketing → Settings).');
    if (settings.token_expires_at && new Date(settings.token_expires_at) < new Date()) throw new BadRequestException('The Meta connection expired – connect again.');
    if (!settings.ad_account_id) throw new BadRequestException('Choose an ad account first (Marketing → Settings).');
    return { token: settings.meta_user_token, account: settings.ad_account_id, settings };
  }

  private graphError(error: unknown): never {
    if (error instanceof GraphError) throw new BadRequestException(`Meta: ${error.message}`);
    throw error;
  }

  /* ═══════════════ 1) Ad tracking ═══════════════ */

  /**
   * After Meta's webhook messages are saved: links the chat to the ad / short link / campaign that brought the customer.
   * WhatsApp: ad referral (Click-to-WhatsApp) or "#slug" in the text. Messenger / Instagram: ad referral or m.me / ig.me "ref".
   */
  async captureReferrals(body: unknown, platform: 'whatsapp' | 'messenger' | 'instagram') {
    const root = (body as { body?: unknown })?.body && !(body as { entry?: unknown }).entry ? (body as { body: unknown }).body : body;
    const payload = root as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, any>> } }>; messaging?: Array<Record<string, any>> }>; data?: unknown };
    type Found = {
      mid?: string; senderId?: string; companyId?: number | null; kind: 'ad' | 'ref' | 'text'; value: string; type?: string; headline?: string; body?: string; url?: string;
      clid?: string | null; mediaUrl?: string | null; mediaType?: string | null;
    };
    const found: Found[] = [];
    const str = (value: unknown) => (value == null ? '' : String(value));
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          const r = message.referral;
          if (r?.source_id) {
            // Click-to-WhatsApp: ad (source_type ad) or a boosted / shared post (source_type post)
            found.push({ mid: message.id, kind: 'ad', value: str(r.source_id), type: str(r.source_type || 'ad'), headline: str(r.headline),
              body: str(r.body), url: str(r.source_url), clid: r.ctwa_clid ? str(r.ctwa_clid) : null,
              mediaUrl: str(r.image_url || r.thumbnail_url || r.video_url) || null, mediaType: r.media_type ? str(r.media_type) : null });
          }
          const text = str(message.text?.body);
          if (text && linkTags(text).length) found.push({ mid: message.id, kind: 'text', value: text });
        }
      }
      // Messenger / Instagram: the Page (entry.id) tells which shop the customer wrote to (a person's id is only unique per Page)
      const pageCompany = entry.messaging?.length ? await this.pageCompany(String((entry as { id?: string }).id ?? '')) : null;
      for (const event of entry.messaging ?? []) {
        const r = event.referral ?? event.message?.referral ?? event.postback?.referral;
        const senderId = event.sender?.id ? str(event.sender.id) : undefined;
        if (r?.card) {
          // the customer answered the ad / post card Meta showed them, but Meta sent no ad id (read from the replied-to message)
          found.push({ mid: event.message?.mid, senderId, companyId: pageCompany, kind: 'ad', value: str(r.card.key).slice(0, 64), type: 'card',
            headline: str(r.card.title), body: '', url: str(r.card.link), clid: null, mediaUrl: str(r.card.media_url) || null, mediaType: r.card.media_type ? str(r.card.media_type) : null });
        } else if (r && (r.ad_id || r.source === 'ADS' || r.ads_context_data)) {
          const ctx = r.ads_context_data ?? {};
          found.push({ mid: event.message?.mid, senderId, companyId: pageCompany, kind: 'ad', value: str(r.ad_id ?? (ctx.post_id ? `post-${ctx.post_id}` : r.ref) ?? 'unknown'), type: r.ad_id ? 'ad' : ctx.post_id ? 'post' : 'ad',
            headline: str(ctx.ad_title), body: '', url: str(ctx.post_id ? `https://www.facebook.com/${ctx.post_id}` : ''), clid: null,
            mediaUrl: str(ctx.photo_url || ctx.video_url) || null, mediaType: ctx.video_url ? 'video' : ctx.photo_url ? 'image' : null });
        } else if (r?.ref) {
          found.push({ mid: event.message?.mid, senderId, companyId: pageCompany, kind: 'ref', value: str(r.ref) });
        }
        const text = str(event.message?.text);
        if (text && linkTags(text).length) found.push({ mid: event.message?.mid, senderId, companyId: pageCompany, kind: 'text', value: text });
      }
    }
    // QR WhatsApp (Evolution): the ad comes as contextInfo.externalAdReply on the message
    if (platform === 'whatsapp' && payload?.data) {
      const items = (Array.isArray(payload.data) ? payload.data : [payload.data]) as Array<Record<string, any>>;
      for (const item of items) {
        if (item?.key?.fromMe) continue;
        const message = (item?.message ?? {}) as Record<string, any>;
        let ad: Record<string, any> | undefined = item?.contextInfo?.externalAdReply;
        for (const part of Object.values(message)) {
          if (!ad && part && typeof part === 'object') ad = (part as { contextInfo?: { externalAdReply?: Record<string, any> } }).contextInfo?.externalAdReply;
        }
        if (ad && (ad.sourceId || ad.sourceUrl || ad.title)) {
          found.push({ mid: item?.key?.id ? str(item.key.id) : undefined, kind: 'ad', value: str(ad.sourceId || ad.sourceUrl || ad.title).slice(0, 64),
            type: str(ad.sourceType || 'ad'), headline: str(ad.title), body: str(ad.body), url: str(ad.sourceUrl), clid: ad.ctwaClid ? str(ad.ctwaClid) : null,
            mediaUrl: str(ad.thumbnailUrl || ad.mediaUrl || ad.originalImageUrl) || null, mediaType: Number(ad.mediaType) === 2 ? 'video' : 'image' });
        }
        const text = str(message.conversation ?? message.extendedTextMessage?.text);
        if (text && linkTags(text).length && item?.key?.id) found.push({ mid: str(item.key.id), kind: 'text', value: text });
      }
    }
    for (const ref of found) {
      let conversation: { id: number; company_id: number; channel_user_id: number | null } | null = null;
      if (ref.mid) {
        const [row] = await this.dataSource.query(`
          SELECT m.conversation_id AS id, cu.company_id, cu.id AS channel_user_id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
            JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE m.provider_message_id = $1 OR m.provider_message_id LIKE $1 || ':%' ORDER BY m.id LIMIT 1`, [ref.mid]);
        conversation = row ? { id: Number(row.id), company_id: Number(row.company_id), channel_user_id: row.channel_user_id ? Number(row.channel_user_id) : null } : null;
      }
      if (!conversation && ref.senderId) {
        const [row] = await this.dataSource.query(`
          SELECT c.id, cu.company_id, cu.id AS channel_user_id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE cu.platform = $1 AND cu.external_user_id = $2 AND ($3::bigint IS NULL OR cu.company_id = $3) ORDER BY c.id DESC LIMIT 1`, [platform, ref.senderId, ref.companyId ?? null]);
        conversation = row ? { id: Number(row.id), company_id: Number(row.company_id), channel_user_id: row.channel_user_id ? Number(row.channel_user_id) : null } : null;
      }
      if (!conversation) {
        // a referral before the first message (new customer): keep it until the chat exists
        if (ref.senderId && ref.kind !== 'text') await savePendingRef(this.dataSource, platform, ref.senderId, { kind: ref.kind, value: ref.value, headline: ref.headline, body: ref.body, url: ref.url, media_url: ref.mediaUrl ?? undefined, media_type: ref.mediaType ?? undefined });
        continue;
      }
      if (ref.kind === 'text') { await attributeText(this.dataSource, conversation.id, conversation.company_id, ref.value); continue; }
      if (ref.kind === 'ref') { await attributeRef(this.dataSource, conversation.id, conversation.company_id, ref.value); continue; }
      // every ad click is kept once (the same webhook message is never counted twice)
      const recorded = await recordAdClick(this.dataSource, {
        companyId: conversation.company_id, conversationId: conversation.id, channelUserId: conversation.channel_user_id, platform, adId: ref.value,
        sourceType: ref.type ?? 'ad', headline: ref.headline ?? '', body: ref.body ?? '', url: ref.url ?? '', mediaUrl: ref.mediaUrl ?? null, mediaType: ref.mediaType ?? null,
        providerMessageId: ref.mid ?? null,
      });
      if (!recorded) continue;
      // latest ad click wins for this chat
      await this.dataSource.query(`
        UPDATE bot_conversation SET ad_source_id = $2, ad_source_type = $3, ad_headline = $4, ad_source_url = $5,
               ad_ctwa_clid = COALESCE($6, ad_ctwa_clid), ad_platform = $7, ad_referred_at = NOW(), ad_body = $8, ad_media_url = $9, ad_media_type = $10
         WHERE id = $1`, [conversation.id, ref.value, ref.type ?? 'ad', String(ref.headline || ref.body || '').slice(0, 1000), String(ref.url ?? '').slice(0, 1000), ref.clid ?? null, platform,
        String(ref.body ?? '').slice(0, 2000), ref.mediaUrl ?? null, ref.mediaType ?? null]);
      // a new ad click is a new deal: a customer who already bought (won) or said no (lost) starts again as a new lead,
      // so this visit gets its own result (the history keeps the old one – lead_stage_event)
      await this.dataSource.query(`UPDATE bot_conversation SET lead_stage = 'new' WHERE id = $1 AND lead_stage IN ('won', 'lost')`, [conversation.id]).catch(() => undefined);
      await this.resolveAdCampaign(conversation.company_id, ref.value).catch(() => undefined);
      await attributeAd(this.dataSource, conversation.id, conversation.company_id, ref.value);
    }
    // Messenger / Instagram: an ad opened the chat before the first message ("get started") → link it now that the chat exists
    for (const entry of payload?.entry ?? []) {
      if (!entry.messaging?.length) continue;
      const pageCompany = await this.pageCompany(String((entry as { id?: string }).id ?? ''));
      for (const event of entry.messaging ?? []) {
        if (!event.message || event.message.is_echo || !event.sender?.id) continue;
        const [row] = await this.dataSource.query(`
          SELECT c.id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE cu.platform = $1 AND cu.external_user_id = $2 AND ($3::bigint IS NULL OR cu.company_id = $3) ORDER BY c.id DESC LIMIT 1`, [platform, String(event.sender.id), pageCompany]);
        if (row) await applyPendingRefs(this.dataSource, Number(row.id)).catch(() => undefined);
      }
    }
  }

  /* ═══════════════ Ads & leads: ad by ad ═══════════════ */

  /** The Meta login when connected (no error when it is not: our own chats still show). */
  private async optionalMeta(companyId: number) {
    const s = await this.settings(companyId);
    return s.meta_user_token && (!s.token_expires_at || new Date(s.token_expires_at) > new Date()) ? { token: s.meta_user_token } : null;
  }

  async adsReport(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const meta = await this.optionalMeta(companyId);
    const report = await adsReport(this.dataSource, companyId, days, meta);
    // ad / campaign names for ads Meta could name (cached for next time)
    const unnamed = report.ads.filter((a) => !a.campaign_id).map((a) => a.ad_id);
    if (unnamed.length && (await this.fillAdNames(companyId, unnamed))) return adsReport(this.dataSource, companyId, days, meta);
    return report;
  }

  async adReport(user: AuthenticatedUser, adId: string, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const report = await adReport(this.dataSource, companyId, String(adId).slice(0, 64), days, await this.optionalMeta(companyId));
    if (!report) throw new NotFoundException('No chats from this ad yet.');
    return report;
  }

  async adAccountsSummary(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const settings = await this.settings(companyId);
    if (!settings.meta_user_token) throw new BadRequestException('Connect with Meta first (Marketing → Settings).');
    try { return await adAccountsSummary(settings.meta_user_token, settings.ad_account_id); } catch (error) { this.graphError(error); }
  }

  /** The shop of a Facebook Page / Instagram account id (null when unknown). */
  private async pageCompany(accountId: string): Promise<number | null> {
    if (!accountId) return null;
    const [row] = await this.dataSource.query(`
      SELECT company_id FROM meta_page_connections WHERE (page_id = $1 OR instagram_business_account_id = $1) AND status = 'CONNECTED'
       ORDER BY updated_at DESC LIMIT 1`, [accountId]).catch(() => []);
    return row ? Number(row.company_id) : null;
  }

  /** Fills the ad → Meta campaign cache when the ad account is connected (so campaigns can match by Meta campaign). */
  private async resolveAdCampaign(companyId: number, adId: string) {
    const [cached] = await this.dataSource.query(`SELECT campaign_id, lookup_failed_at FROM marketing_ad_cache WHERE ad_id = $1`, [adId]);
    if (cached?.campaign_id) return;
    if (cached?.lookup_failed_at && Date.now() - new Date(cached.lookup_failed_at).getTime() < 24 * 3600_000) return;
    const settings = await this.settings(companyId);
    if (!settings.meta_user_token || !/^\d+$/.test(adId)) return;
    try {
      const ad = await graphRequest<{ name?: string; adset_id?: string; campaign?: { id: string; name: string } }>('GET', `/${adId}`, settings.meta_user_token, { fields: 'name,adset_id,campaign{id,name}' });
      await this.dataSource.query(`
        INSERT INTO marketing_ad_cache (ad_id, ad_name, adset_id, campaign_id, campaign_name, company_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (ad_id) DO UPDATE SET ad_name = EXCLUDED.ad_name, adset_id = EXCLUDED.adset_id, campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name, company_id = EXCLUDED.company_id, lookup_failed_at = NULL, updated_at = NOW()`,
        [adId, ad.name ?? null, ad.adset_id ?? null, ad.campaign?.id ?? null, ad.campaign?.name ?? null, companyId]);
    } catch {
      await this.dataSource.query(`
        INSERT INTO marketing_ad_cache (ad_id, company_id, lookup_failed_at) VALUES ($1, $2, NOW())
        ON CONFLICT (ad_id) DO UPDATE SET lookup_failed_at = NOW()`, [adId, companyId]);
    }
  }

  /** Chats, people, orders, bookings and revenue per ad (orders within 28 days after the ad click). */
  async attribution(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH ad_convs AS (
        SELECT c.id, c.bot_channel_user_id, c.ad_source_id, c.ad_headline, c.ad_platform, c.ad_referred_at
          FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
         WHERE cu.company_id = $1 AND c.ad_source_id IS NOT NULL AND c.ad_referred_at > NOW() - make_interval(days => $2::int)
      ),
      ad_orders AS (
        SELECT DISTINCT ON (o.id) o.id, o.total_amount, a.ad_source_id
          FROM bot_order o JOIN ad_convs a ON a.bot_channel_user_id = o.bot_channel_user_id
           AND o.created_at >= a.ad_referred_at AND o.created_at < a.ad_referred_at + make_interval(days => $3::int)
         WHERE o.status::text <> 'Cancelled'
         ORDER BY o.id, a.ad_referred_at DESC
      )
      SELECT a.ad_source_id, MAX(a.ad_headline) AS headline, MAX(a.ad_platform) AS platform,
             COUNT(*)::int AS chats, COUNT(DISTINCT a.bot_channel_user_id)::int AS people,
             (SELECT COUNT(*) FROM ad_orders x WHERE x.ad_source_id = a.ad_source_id)::int AS orders,
             (SELECT COALESCE(SUM(total_amount), 0) FROM ad_orders x WHERE x.ad_source_id = a.ad_source_id) AS revenue,
             (SELECT COUNT(*) FROM bot_booking b WHERE b.conversation_id IN (SELECT id FROM ad_convs y WHERE y.ad_source_id = a.ad_source_id))::int AS bookings,
             MAX(m.ad_name) AS ad_name, MAX(m.campaign_id) AS campaign_id, MAX(m.campaign_name) AS campaign_name
        FROM ad_convs a LEFT JOIN marketing_ad_cache m ON m.ad_id = a.ad_source_id
       GROUP BY a.ad_source_id ORDER BY chats DESC`, [companyId, days, ATTRIBUTION_DAYS]);
    const unnamed = rows.filter((row) => !row.campaign_id).map((row) => String(row.ad_source_id));
    if (unnamed.length && (await this.fillAdNames(companyId, unnamed))) return this.attribution(user, days); // names now cached
    const [organic] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS chats FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE cu.company_id = $1 AND c.ad_source_id IS NULL AND c.created_at > NOW() - make_interval(days => $2::int)`, [companyId, days]);
    return {
      days, attribution_window_days: ATTRIBUTION_DAYS, organic_chats: num(organic?.chats),
      ads: rows.map((row) => ({ ...row, revenue: num(row.revenue) })),
    };
  }

  /** Looks up ad / campaign names for ad ids (needs the ads connection; silently skipped without it). */
  private async fillAdNames(companyId: number, adIds: string[]): Promise<boolean> {
    const settings = await this.settings(companyId);
    // ads Meta could not name in the last day are not asked again on every page load
    const failed: Array<{ ad_id: string }> = await this.dataSource.query(
      `SELECT ad_id FROM marketing_ad_cache WHERE ad_id = ANY($1::text[]) AND lookup_failed_at > NOW() - INTERVAL '1 day'`, [adIds]);
    const skip = new Set(failed.map((row) => String(row.ad_id)));
    const ids = adIds.filter((id) => /^\d+$/.test(id) && !skip.has(id)).slice(0, 50);
    if (!settings.meta_user_token || !ids.length) return false;
    let filled = false;
    const markFailed = async (list: string[]) => {
      for (const id of list) {
        await this.dataSource.query(`INSERT INTO marketing_ad_cache (ad_id, company_id, lookup_failed_at) VALUES ($1, $2, NOW())
          ON CONFLICT (ad_id) DO UPDATE SET lookup_failed_at = NOW()`, [id, companyId]);
      }
    };
    try {
      const result = await graphRequest<Record<string, { id: string; name?: string; adset_id?: string; campaign?: { id: string; name: string } }>>(
        'GET', '/', settings.meta_user_token, { ids: ids.join(','), fields: 'name,adset_id,campaign{id,name}' });
      for (const ad of Object.values(result)) {
        await this.dataSource.query(`
          INSERT INTO marketing_ad_cache (ad_id, ad_name, adset_id, campaign_id, campaign_name, company_id) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (ad_id) DO UPDATE SET ad_name = EXCLUDED.ad_name, adset_id = EXCLUDED.adset_id, campaign_id = EXCLUDED.campaign_id,
            campaign_name = EXCLUDED.campaign_name, company_id = EXCLUDED.company_id, lookup_failed_at = NULL, updated_at = NOW()`,
          [ad.id, ad.name ?? null, ad.adset_id ?? null, ad.campaign?.id ?? null, ad.campaign?.name ?? null, companyId]);
        if (ad.campaign?.id) filled = true;
      }
      await markFailed(ids.filter((id) => !result[id]?.campaign?.id));
    } catch (error) {
      await markFailed(ids);
      this.logger.warn(`ad names: ${error instanceof Error ? error.message : String(error)}`);
    }
    return filled;
  }

  /* ═══════════════ 2) Ads dashboard + 3) manage ═══════════════ */

  async connectUrl(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    try { return { url: adsLoginUrl(companyId, Number(user.id)) }; } catch (error) { this.graphError(error); }
  }

  /** Meta redirects here after login (public). Returns where to send the browser. */
  async oauthCallback(code: string, state: string): Promise<string> {
    const base = String(process.env.APP_PUBLIC_URL ?? '').replace(/\/+$/, '');
    const back = (result: string) => `${base}/marketing?tab=settings&ads=${result}`;
    const parsed = readAdsState(state);
    if (!parsed || !code) return back('error');
    try {
      const { token, expiresAt } = await exchangeAdsCode(code);
      await this.saveSettings(parsed.companyId, { meta_user_token: token, token_expires_at: expiresAt });
      return back('connected');
    } catch (error) {
      this.logger.warn(`ads login failed: ${error instanceof Error ? error.message : String(error)}`);
      return back('error');
    }
  }

  async adAccounts(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const settings = await this.settings(companyId);
    if (!settings.meta_user_token) throw new BadRequestException('Connect with Meta first.');
    try {
      const result = await graphRequest<{ data: Array<{ id: string; name: string; currency: string; account_status: number }> }>(
        'GET', '/me/adaccounts', settings.meta_user_token, { fields: 'id,name,currency,account_status', limit: '100' });
      return result.data.map((row) => ({ ...row, active: row.account_status === 1 }));
    } catch (error) { this.graphError(error); }
  }

  async chooseAdAccount(user: AuthenticatedUser, adAccountId: string) {
    const companyId = await this.adminCompany(user);
    const accounts = await this.adAccounts(user);
    const account = accounts.find((row) => row.id === adAccountId);
    if (!account) throw new BadRequestException('This ad account is not available for your Meta login.');
    await this.saveSettings(companyId, { ad_account_id: account.id, ad_account_name: account.name, ad_currency: account.currency });
    return this.publicSettings(user);
  }

  async disconnect(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    await this.saveSettings(companyId, { meta_user_token: null, token_expires_at: null, ad_account_id: null, ad_account_name: null, ad_currency: null });
    return this.publicSettings(user);
  }

  /** Settings without secrets. */
  async publicSettings(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const s = await this.settings(companyId);
    const [channel] = await this.dataSource.query(`SELECT provider_type, meta_waba_id, meta_phone_number_id FROM whatsapp_channels WHERE company_id = $1 LIMIT 1`, [companyId]);
    return {
      ads_connected: Boolean(s.meta_user_token), token_expires_at: s.token_expires_at,
      ad_account_id: s.ad_account_id, ad_account_name: s.ad_account_name, ad_currency: s.ad_currency,
      dataset_id: s.dataset_id, capi_token_set: Boolean(s.capi_token), capi_enabled: s.capi_enabled, capi_test_code: s.capi_test_code,
      whatsapp_cloud: channel?.provider_type === 'meta' && Boolean(channel?.meta_phone_number_id),
      meta_app_ready: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.PUBLIC_API_BASE_URL),
    };
  }

  async campaigns(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const { token, account, settings } = await this.adsToken(companyId);
    const days = Number(daysRaw) || 30;
    const preset = days <= 7 ? 'last_7d' : days <= 30 ? 'last_30d' : 'last_90d';
    try {
      const [campaigns, insights] = await Promise.all([
        graphRequest<{ data: Array<Record<string, any>> }>('GET', `/${account}/campaigns`, token,
          { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', limit: '100' }),
        graphRequest<{ data: Array<Record<string, any>> }>('GET', `/${account}/insights`, token,
          { level: 'campaign', date_preset: preset, fields: 'campaign_id,spend,impressions,reach,clicks,inline_link_clicks,ctr,actions', limit: '200' }),
      ]);
      const ours = await this.attribution(user, days);
      const byCampaign = new Map<string, { chats: number; orders: number; revenue: number; bookings: number }>();
      for (const ad of ours.ads as Array<Record<string, unknown>>) {
        const id = String(ad.campaign_id ?? '');
        if (!id) continue;
        const current = byCampaign.get(id) ?? { chats: 0, orders: 0, revenue: 0, bookings: 0 };
        byCampaign.set(id, { chats: current.chats + num(ad.chats), orders: current.orders + num(ad.orders), revenue: current.revenue + num(ad.revenue), bookings: current.bookings + num(ad.bookings) });
      }
      const insight = new Map(insights.data.map((row) => [String(row.campaign_id), row]));
      return {
        currency: settings.ad_currency, days, ad_account_name: settings.ad_account_name,
        campaigns: campaigns.data.map((c) => {
          const i = insight.get(String(c.id)) ?? {};
          const actions = (i.actions as Array<{ action_type: string; value: string }> | undefined) ?? [];
          const contact = contactActions(actions);
          const started = contact.conversations_started;
          const spend = num(i.spend);
          const result = byCampaign.get(String(c.id)) ?? { chats: 0, orders: 0, revenue: 0, bookings: 0 };
          return {
            id: c.id, name: c.name, status: c.status, effective_status: c.effective_status, objective: c.objective,
            daily_budget: fromMinorUnits(c.daily_budget), lifetime_budget: fromMinorUnits(c.lifetime_budget),
            spend, impressions: num(i.impressions), reach: num(i.reach), clicks: num(i.clicks), conversations_started: started,
            link_clicks: num(i.inline_link_clicks), ctr: num(i.ctr), contact_clicks: started + contact.calls + contact.leads,
            cost_per_conversation: started ? spend / started : null,
            chats: result.chats, orders: result.orders, bookings: result.bookings, revenue: result.revenue,
            cost_per_chat: result.chats ? spend / result.chats : null, cost_per_order: result.orders ? spend / result.orders : null,
            roas: spend > 0 ? result.revenue / spend : null,
          };
        }),
      };
    } catch (error) { this.graphError(error); }
  }

  /**
   * One Meta ad campaign in depth: totals, day-by-day, contact clicks (chats started, first replies, link clicks, calls, leads),
   * ad sets and ads with their results, where it was shown, and the people it brought into the chats (with their orders).
   */
  async campaignDetail(user: AuthenticatedUser, campaignId: string, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const { token, account, settings } = await this.adsToken(companyId);
    await this.assertCampaign(token, account, campaignId);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 90);
    const until = new Date();
    const since = new Date(until.getTime() - (days - 1) * 86400_000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const time_range = JSON.stringify({ since: ymd(since), until: ymd(until) });
    const metricFields = 'spend,impressions,reach,frequency,clicks,unique_clicks,inline_link_clicks,ctr,cpc,cpm,actions,cost_per_action_type';
    type Row = Record<string, any>;
    const safe = <T>(promise: Promise<T>, fallback: T) => promise.catch((error) => { this.logger.warn(`campaign detail: ${error instanceof Error ? error.message : String(error)}`); return fallback; });
    let campaign: Row;
    try {
      campaign = await graphRequest<Row>('GET', `/${campaignId}`, token, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time' });
    } catch (error) { this.graphError(error); }
    const [total, daily, adsets, ads, placements, ageGender] = await Promise.all([
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/insights`, token, { time_range, fields: metricFields }), { data: [] }),
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/insights`, token, { time_range, time_increment: '1', fields: 'spend,impressions,reach,clicks,inline_link_clicks,actions', limit: '100' }), { data: [] }),
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/adsets`, token, { fields: `id,name,status,effective_status,daily_budget,optimization_goal,insights.time_range(${time_range}){spend,impressions,reach,clicks,inline_link_clicks,ctr,actions}`, limit: '50' }), { data: [] }),
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/ads`, token, { fields: `id,name,status,effective_status,adset_id,creative{thumbnail_url,title,body},insights.time_range(${time_range}){spend,impressions,reach,clicks,inline_link_clicks,ctr,actions}`, limit: '100' }), { data: [] }),
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/insights`, token, { time_range, breakdowns: 'publisher_platform', fields: 'spend,impressions,clicks,actions' }), { data: [] }),
      safe(graphRequest<{ data: Row[] }>('GET', `/${campaignId}/insights`, token, { time_range, breakdowns: 'age,gender', fields: 'spend,impressions,clicks,actions', limit: '100' }), { data: [] }),
    ]);

    // ── our side: chats and orders from this campaign's ads ──
    const people: Row[] = await this.dataSource.query(`
      WITH convs AS (
        SELECT c.id, c.bot_channel_user_id, c.ad_source_id, c.ad_referred_at, c.ad_platform
          FROM bot_conversation c
          JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
          JOIN marketing_ad_cache m ON m.ad_id = c.ad_source_id
         WHERE cu.company_id = $1 AND m.campaign_id = $2 AND c.ad_referred_at > NOW() - make_interval(days => $3::int)
      )
      SELECT cu.id AS contact_user_id, cu.display_name, cu.external_user_id, cu.platform,
             MIN(v.ad_referred_at) AS first_click, MAX(v.ad_referred_at) AS last_click, COUNT(*)::int AS chats,
             MAX(m.ad_name) AS ad_name, MAX(v.id) AS conversation_id,
             (SELECT COUNT(*) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled'
                AND o.created_at >= MIN(v.ad_referred_at) AND o.created_at < MAX(v.ad_referred_at) + make_interval(days => $4::int))::int AS orders,
             (SELECT COALESCE(SUM(o.total_amount), 0) FROM bot_order o WHERE o.bot_channel_user_id = cu.id AND o.status::text <> 'Cancelled'
                AND o.created_at >= MIN(v.ad_referred_at) AND o.created_at < MAX(v.ad_referred_at) + make_interval(days => $4::int)) AS revenue
        FROM convs v JOIN bot_channel_user cu ON cu.id = v.bot_channel_user_id
        LEFT JOIN marketing_ad_cache m ON m.ad_id = v.ad_source_id
       GROUP BY cu.id ORDER BY MAX(v.ad_referred_at) DESC LIMIT 500`, [companyId, campaignId, days, ATTRIBUTION_DAYS]);
    const ourDaily: Array<{ day: string; chats: number }> = await this.dataSource.query(`
      SELECT to_char(date_trunc('day', c.ad_referred_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS chats
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
        JOIN marketing_ad_cache m ON m.ad_id = c.ad_source_id
       WHERE cu.company_id = $1 AND m.campaign_id = $2 AND c.ad_referred_at > NOW() - make_interval(days => $3::int)
       GROUP BY 1`, [companyId, campaignId, days]);
    const ourByAd: Array<{ ad_id: string; chats: number }> = await this.dataSource.query(`
      SELECT c.ad_source_id AS ad_id, COUNT(*)::int AS chats
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE cu.company_id = $1 AND c.ad_source_id = ANY($2::text[]) AND c.ad_referred_at > NOW() - make_interval(days => $3::int)
       GROUP BY 1`, [companyId, ads.data.map((a) => String(a.id)), days]);

    const t = total.data[0] ?? {};
    const contact = contactActions(t.actions);
    const spend = num(t.spend);
    const orders = people.reduce((n, p) => n + num(p.orders), 0);
    const revenue = people.reduce((n, p) => n + num(p.revenue), 0);
    const chatsTracked = people.reduce((n, p) => n + num(p.chats), 0);
    const ourDay = new Map(ourDaily.map((d) => [d.day, num(d.chats)]));
    const adChats = new Map(ourByAd.map((r) => [String(r.ad_id), num(r.chats)]));
    const metrics = (i: Row | undefined) => {
      const c = contactActions(i?.actions);
      const sp = num(i?.spend);
      return {
        spend: sp, impressions: num(i?.impressions), reach: num(i?.reach), clicks: num(i?.clicks), link_clicks: num(i?.inline_link_clicks),
        ctr: num(i?.ctr), conversations_started: c.conversations_started, cost_per_conversation: c.conversations_started ? sp / c.conversations_started : null,
      };
    };
    return {
      currency: settings.ad_currency, days, since: ymd(since), until: ymd(until),
      campaign: {
        id: campaign.id, name: campaign.name, status: campaign.status, effective_status: campaign.effective_status, objective: campaign.objective,
        daily_budget: fromMinorUnits(campaign.daily_budget), lifetime_budget: fromMinorUnits(campaign.lifetime_budget),
        start_time: campaign.start_time ?? null, stop_time: campaign.stop_time ?? null,
      },
      totals: {
        spend, impressions: num(t.impressions), reach: num(t.reach), frequency: num(t.frequency), clicks: num(t.clicks), unique_clicks: num(t.unique_clicks),
        link_clicks: num(t.inline_link_clicks), ctr: num(t.ctr), cpc: num(t.cpc), cpm: num(t.cpm),
        ...contact,
        contact_clicks: contact.conversations_started + contact.calls + contact.leads,
        cost_per_conversation: contact.conversations_started ? spend / contact.conversations_started : null,
        chats_tracked: chatsTracked, people: people.length, orders, revenue,
        cost_per_order: orders ? spend / orders : null, roas: spend > 0 ? revenue / spend : null,
        conversion_rate: people.length ? orders / people.length : null,
      },
      daily: daily.data.map((d) => ({
        day: String(d.date_start), spend: num(d.spend), impressions: num(d.impressions), reach: num(d.reach), clicks: num(d.clicks), link_clicks: num(d.inline_link_clicks),
        conversations_started: contactActions(d.actions).conversations_started, chats_tracked: ourDay.get(String(d.date_start)) ?? 0,
      })),
      adsets: adsets.data.map((a) => ({ id: a.id, name: a.name, status: a.effective_status ?? a.status, daily_budget: fromMinorUnits(a.daily_budget), optimization_goal: a.optimization_goal ?? null, ...metrics(a.insights?.data?.[0]) })),
      ads: ads.data.map((a) => ({
        id: a.id, name: a.name, status: a.effective_status ?? a.status, adset_id: a.adset_id,
        thumbnail: a.creative?.thumbnail_url ?? null, title: a.creative?.title ?? null, body: a.creative?.body ?? null,
        ...metrics(a.insights?.data?.[0]), chats_tracked: adChats.get(String(a.id)) ?? 0,
      })),
      placements: placements.data.map((p) => ({ platform: String(p.publisher_platform ?? 'other'), spend: num(p.spend), impressions: num(p.impressions), clicks: num(p.clicks), conversations_started: contactActions(p.actions).conversations_started })),
      audience: ageGender.data.map((p) => ({ age: String(p.age ?? ''), gender: String(p.gender ?? ''), spend: num(p.spend), impressions: num(p.impressions), clicks: num(p.clicks), conversations_started: contactActions(p.actions).conversations_started })),
      people: people.map((p) => ({
        contact_user_id: Number(p.contact_user_id), conversation_id: Number(p.conversation_id), name: p.display_name || p.external_user_id, phone: p.platform === 'whatsapp' ? p.external_user_id : null,
        platform: p.platform, ad_name: p.ad_name, first_click: p.first_click, last_click: p.last_click, chats: num(p.chats), orders: num(p.orders), revenue: num(p.revenue),
      })),
    };
  }

  async setCampaignStatus(user: AuthenticatedUser, campaignId: string, status: 'ACTIVE' | 'PAUSED') {
    const companyId = await this.adminCompany(user);
    const { token, account } = await this.adsToken(companyId);
    await this.assertCampaign(token, account, campaignId);
    try { await graphRequest('POST', `/${campaignId}`, token, { status }); } catch (error) { this.graphError(error); }
    return { id: campaignId, status };
  }

  async setCampaignBudget(user: AuthenticatedUser, campaignId: string, dailyBudget: number) {
    const companyId = await this.adminCompany(user);
    const { token, account } = await this.adsToken(companyId);
    await this.assertCampaign(token, account, campaignId);
    try {
      await graphRequest('POST', `/${campaignId}`, token, { daily_budget: String(toMinorUnits(dailyBudget)) });
    } catch (error) {
      if (error instanceof GraphError && /budget/i.test(error.message)) {
        throw new BadRequestException('Meta: this campaign has its budget on the ad sets (not the campaign). Change it in Ads Manager.');
      }
      this.graphError(error);
    }
    return { id: campaignId, daily_budget: dailyBudget };
  }

  /** Only campaigns of the connected ad account can be changed. */
  private async assertCampaign(token: string, account: string, campaignId: string) {
    if (!/^\d+$/.test(campaignId)) throw new BadRequestException('Unknown campaign.');
    try {
      const campaign = await graphRequest<{ account_id?: string }>('GET', `/${campaignId}`, token, { fields: 'account_id' });
      if (`act_${campaign.account_id}` !== account) throw new ForbiddenException('This campaign is not in your ad account.');
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      this.graphError(error);
    }
  }

  /* ═══════════════ 4) Conversions API ═══════════════ */

  async saveCapi(user: AuthenticatedUser, dto: { dataset_id?: string; capi_token?: string; capi_enabled?: boolean; capi_test_code?: string }) {
    const companyId = await this.adminCompany(user);
    const values: Partial<Settings> = {};
    if (dto.dataset_id !== undefined) values.dataset_id = dto.dataset_id.trim() || null;
    if (dto.capi_token !== undefined && dto.capi_token.trim()) values.capi_token = dto.capi_token.trim();
    if (dto.capi_test_code !== undefined) values.capi_test_code = dto.capi_test_code.trim() || null;
    if (dto.capi_enabled !== undefined) values.capi_enabled = dto.capi_enabled;
    await this.saveSettings(companyId, values);
    const s = await this.settings(companyId);
    if (s.capi_enabled && (!s.dataset_id || !s.capi_token)) {
      await this.saveSettings(companyId, { capi_enabled: false });
      throw new BadRequestException('Add the dataset id and the access token before switching the Conversions API on.');
    }
    return this.publicSettings(user);
  }

  async capiLog(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    return this.dataSource.query(`SELECT event_name, ref, status, response, created_at FROM marketing_capi_event WHERE company_id = $1 ORDER BY id DESC LIMIT 50`, [companyId]);
  }

  private async cursor(name: string, startSql: string): Promise<number> {
    const [row] = await this.dataSource.query(`SELECT last_id FROM push_cursor WHERE name = $1`, [name]);
    if (row) return Number(row.last_id);
    const [start] = await this.dataSource.query(startSql);
    const id = Number(start?.id ?? 0);
    await this.dataSource.query(`INSERT INTO push_cursor (name, last_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, id]);
    return id;
  }

  private async moveCursor(name: string, id: number) {
    await this.dataSource.query(`UPDATE push_cursor SET last_id = $2 WHERE name = $1`, [name, id]);
  }

  /** Purchases (new orders) and leads / bookings from ad chats → Meta, so Meta finds more buyers. */
  private async sendConversions() {
    const lastOrder = await this.cursor('capi_orders', `SELECT COALESCE(MAX(id), 0) AS id FROM bot_order`);
    const orders = await this.dataSource.query(`SELECT id, company_id, bot_channel_user_id, total_amount, created_at FROM bot_order WHERE id > $1 AND status::text <> 'Cancelled' ORDER BY id LIMIT 100`, [lastOrder]);
    for (const order of orders) {
      await this.sendEvent(Number(order.company_id), 'Purchase', `order-${order.id}`, Number(order.bot_channel_user_id), new Date(order.created_at), { currency: 'LKR', value: num(order.total_amount) });
    }
    if (orders.length) await this.moveCursor('capi_orders', Number(orders[orders.length - 1].id));

    const lastLead = await this.cursor('capi_leads', `SELECT COALESCE(MAX(id), 0) AS id FROM bot_message`);
    const [maxMessage] = await this.dataSource.query(`SELECT COALESCE(MAX(id), 0) AS id FROM bot_message`); // read first: nothing is skipped
    const leads = await this.dataSource.query(`
      SELECT m.id, cu.company_id, cu.id AS channel_user_id, m.created_at, m.intent FROM bot_message m
        JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE m.id > $1 AND m.id <= $2 AND (m.intent LIKE '%lead%' OR m.intent LIKE '%booking%') ORDER BY m.id LIMIT 100`, [lastLead, Number(maxMessage?.id ?? 0)]);
    for (const lead of leads) {
      await this.sendEvent(Number(lead.company_id), 'LeadSubmitted', `msg-${lead.id}`, Number(lead.channel_user_id), new Date(lead.created_at), {});
    }
    if (Number(maxMessage?.id) > lastLead) await this.moveCursor('capi_leads', leads.length === 100 ? Number(leads[99].id) : Number(maxMessage.id));
  }

  private async sendEvent(companyId: number, eventName: string, ref: string, channelUserId: number, when: Date, custom: Record<string, unknown>) {
    const settings = await this.settings(companyId);
    if (!settings.capi_enabled || !settings.dataset_id || !settings.capi_token) return;
    // the chat must have come from an ad within the attribution window
    const [conversation] = await this.dataSource.query(`
      SELECT c.ad_platform, c.ad_ctwa_clid, cu.external_user_id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE c.bot_channel_user_id = $1 AND c.ad_source_id IS NOT NULL AND c.ad_referred_at <= $2 AND c.ad_referred_at > $2::timestamptz - make_interval(days => $3::int)
       ORDER BY c.ad_referred_at DESC LIMIT 1`, [channelUserId, when, ATTRIBUTION_DAYS]);
    if (!conversation) return;
    const [exists] = await this.dataSource.query(`SELECT 1 FROM marketing_capi_event WHERE company_id = $1 AND event_name = $2 AND ref = $3`, [companyId, eventName, ref]);
    if (exists) return;
    let userData: Record<string, string> | null = null;
    let channel = 'whatsapp';
    if (conversation.ad_platform === 'whatsapp' && conversation.ad_ctwa_clid) {
      const [wa] = await this.dataSource.query(`SELECT meta_waba_id FROM whatsapp_channels WHERE company_id = $1 LIMIT 1`, [companyId]);
      if (wa?.meta_waba_id) userData = { whatsapp_business_account_id: String(wa.meta_waba_id), ctwa_clid: String(conversation.ad_ctwa_clid) };
    } else if (conversation.ad_platform === 'messenger' || conversation.ad_platform === 'instagram') {
      const [page] = await this.dataSource.query(`SELECT page_id, instagram_business_account_id FROM meta_page_connections WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY id DESC LIMIT 1`, [companyId]);
      channel = conversation.ad_platform;
      if (page && channel === 'messenger') userData = { page_id: String(page.page_id), page_scoped_user_id: String(conversation.external_user_id) };
      if (page?.instagram_business_account_id && channel === 'instagram') userData = { ig_account_id: String(page.instagram_business_account_id), ig_sid: String(conversation.external_user_id) };
    }
    if (!userData) return;
    const body: Record<string, unknown> = {
      data: [{
        event_name: eventName, event_time: Math.floor(when.getTime() / 1000), event_id: `${companyId}-${ref}`,
        action_source: 'business_messaging', messaging_channel: channel, user_data: userData, ...(Object.keys(custom).length ? { custom_data: custom } : {}),
      }],
      ...(settings.capi_test_code ? { test_event_code: settings.capi_test_code } : {}),
    };
    let status = 'sent';
    let response = '';
    try {
      response = JSON.stringify(await graphRequest('POST', `/${settings.dataset_id}/events`, settings.capi_token, body)).slice(0, 500);
    } catch (error) {
      status = 'failed';
      response = error instanceof Error ? error.message.slice(0, 500) : String(error);
    }
    await this.dataSource.query(`
      INSERT INTO marketing_capi_event (company_id, event_name, ref, status, response) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [companyId, eventName, ref, status, response]);
  }

  /* ═══════════════ 5) WhatsApp broadcasts ═══════════════ */

  private async cloudChannel(companyId: number) {
    const [channel] = await this.dataSource.query(`SELECT provider_type, meta_waba_id, meta_phone_number_id, meta_access_token FROM whatsapp_channels WHERE company_id = $1 LIMIT 1`, [companyId]);
    if (!channel || channel.provider_type !== 'meta' || !channel.meta_phone_number_id || !channel.meta_access_token || !channel.meta_waba_id) {
      throw new BadRequestException('Broadcasts need WhatsApp connected with the official Meta Cloud API (Channels → WhatsApp).');
    }
    return channel as { meta_waba_id: string; meta_phone_number_id: string; meta_access_token: string };
  }

  async templates(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const channel = await this.cloudChannel(companyId);
    try {
      const result = await graphRequest<{ data: Array<{ name: string; language: string; category: string; status: string; components?: Array<{ type: string; text?: string; format?: string }> }> }>(
        'GET', `/${channel.meta_waba_id}/message_templates`, channel.meta_access_token, { fields: 'name,language,category,status,components', limit: '200' });
      return result.data.filter((t) => t.status === 'APPROVED').map((t) => {
        const body = t.components?.find((c) => c.type === 'BODY')?.text ?? '';
        const header = t.components?.find((c) => c.type === 'HEADER');
        return {
          name: t.name, language: t.language, category: t.category, body,
          variables: (body.match(/\{\{\d+\}\}/g) ?? []).length,
          has_media_header: Boolean(header && header.format && header.format !== 'TEXT'),
          /** Meta's sample (hello_world): only works from Meta's test number */
          sample: SAMPLE_TEMPLATES.has(t.name),
        };
      });
    } catch (error) { this.graphError(error); }
  }

  /* ───── Message templates (create / list / delete in WhatsApp Manager through the API) ───── */

  /** Every template with its Meta status (approved, pending, rejected …). */
  async allTemplates(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const channel = await this.cloudChannel(companyId);
    type Raw = {
      id: string; name: string; language: string; category: string; status: string; rejected_reason?: string; quality_score?: { score?: string };
      components?: Array<{ type: string; text?: string; format?: string; buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }> }>;
    };
    try {
      const result = await graphRequest<{ data: Raw[] }>('GET', `/${channel.meta_waba_id}/message_templates`, channel.meta_access_token,
        { fields: 'id,name,language,category,status,rejected_reason,quality_score,components', limit: '250' });
      return result.data.map((t) => {
        const part = (type: string) => t.components?.find((c) => c.type === type);
        const body = part('BODY')?.text ?? '';
        const header = part('HEADER');
        return {
          id: t.id, name: t.name, language: t.language, category: t.category, status: t.status,
          rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
          quality: t.quality_score?.score ?? null,
          header: header ? { format: header.format ?? 'TEXT', text: header.text ?? '' } : null,
          body, footer: part('FOOTER')?.text ?? '',
          buttons: (part('BUTTONS')?.buttons ?? []).map((b) => ({ type: b.type, text: b.text, url: b.url ?? null, phone_number: b.phone_number ?? null })),
          variables: (body.match(/\{\{\d+\}\}/g) ?? []).length,
          sample: SAMPLE_TEMPLATES.has(t.name),
        };
      });
    } catch (error) { this.graphError(error); }
  }

  /** Sends a new template to Meta for review (usually approved in minutes, up to 24 hours). */
  async createTemplate(user: AuthenticatedUser, dto: TemplateInput) {
    const companyId = await this.adminCompany(user);
    const channel = await this.cloudChannel(companyId);
    const components = buildTemplateComponents(dto);
    try {
      const result = await graphRequest<{ id: string; status: string; category: string }>('POST', `/${channel.meta_waba_id}/message_templates`, channel.meta_access_token, {
        name: dto.name, language: dto.language, category: dto.category, components,
      });
      return { id: result.id, status: result.status, category: result.category ?? dto.category, name: dto.name, language: dto.language };
    } catch (error) { this.graphError(error); }
  }

  async deleteTemplate(user: AuthenticatedUser, name: string) {
    const companyId = await this.adminCompany(user);
    const channel = await this.cloudChannel(companyId);
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new BadRequestException('Unknown template.');
    try {
      await graphRequest('DELETE', `/${channel.meta_waba_id}/message_templates`, channel.meta_access_token, { name });
      return { name, deleted: true };
    } catch (error) { this.graphError(error); }
  }

  /** Marketing home: broadcasts, links, campaigns, ads and opt-outs in one view. */
  async overview(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const [channel] = await this.dataSource.query(`SELECT provider_type, meta_phone_number_id FROM whatsapp_channels WHERE company_id = $1 LIMIT 1`, [companyId]);
    const broadcasts: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT id, name, status, template_name, total, scheduled_at, created_at FROM marketing_broadcast
       WHERE company_id = $1 AND created_at > NOW() - make_interval(days => $2::int) ORDER BY id DESC`, [companyId, days]);
    const stats = await this.statsFor(broadcasts.map((b) => Number(b.id)));
    const sum = (key: string) => [...stats.values()].reduce((total, row) => total + num(row[key]), 0);
    const [links] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE l.is_active)::int AS active,
             (SELECT COUNT(*) FROM marketing_link_click k JOIN marketing_link x ON x.id = k.link_id
               WHERE x.company_id = $1 AND k.created_at > NOW() - make_interval(days => $2::int))::int AS clicks
        FROM marketing_link l WHERE l.company_id = $1`, [companyId, days]);
    const [campaigns] = await this.dataSource.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*)::int AS total FROM marketing_campaign WHERE company_id = $1`, [companyId]);
    const [chats] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE c.ad_source_id IS NOT NULL AND c.ad_referred_at > NOW() - make_interval(days => $2::int))::int AS from_ads,
             COUNT(*) FILTER (WHERE c.link_id IS NOT NULL AND c.campaign_at > NOW() - make_interval(days => $2::int))::int AS from_links,
             COUNT(*) FILTER (WHERE c.campaign_id IS NOT NULL AND c.campaign_at > NOW() - make_interval(days => $2::int))::int AS from_campaigns
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id WHERE cu.company_id = $1`, [companyId, days]);
    const [audience] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE cu.platform = 'whatsapp' AND cu.external_user_id ~ '^[0-9+]{9,16}$'
               AND NOT EXISTS (SELECT 1 FROM marketing_optout o WHERE o.company_id = $1 AND o.bot_channel_user_id = cu.id))::int AS reachable,
             (SELECT COUNT(*) FROM marketing_optout o WHERE o.company_id = $1)::int AS opted_out,
             (SELECT COUNT(*) FROM marketing_optout o WHERE o.company_id = $1 AND o.created_at > NOW() - make_interval(days => $2::int))::int AS opted_out_period
        FROM bot_channel_user cu WHERE cu.company_id = $1`, [companyId, days]);
    const daily: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH d AS (SELECT generate_series((NOW() AT TIME ZONE 'Asia/Colombo')::date - ($2::int - 1), (NOW() AT TIME ZONE 'Asia/Colombo')::date, INTERVAL '1 day')::date AS day)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             (SELECT COUNT(*) FROM marketing_link_click k JOIN marketing_link x ON x.id = k.link_id
               WHERE x.company_id = $1 AND (k.created_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS clicks,
             (SELECT COUNT(*) FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
               WHERE cu.company_id = $1 AND c.ad_source_id IS NOT NULL AND (c.ad_referred_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS ad_chats,
             (SELECT COUNT(*) FROM marketing_broadcast_recipient r JOIN marketing_broadcast b ON b.id = r.broadcast_id
               WHERE b.company_id = $1 AND r.status = 'sent' AND (r.sent_at AT TIME ZONE 'Asia/Colombo')::date = d.day)::int AS broadcast_messages
        FROM d ORDER BY d.day`, [companyId, Math.min(days, 90)]);
    const sent = sum('sent');
    // where customers came from and what each source brought (orders / bookings within 28 days of the click or reply)
    const ads = await adsReport(this.dataSource, companyId, days, await this.optionalMeta(companyId)).catch(() => null);
    const sourceRows: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH conv AS (
        SELECT c.id, c.bot_channel_user_id AS cu, c.lead_stage,
               CASE WHEN c.campaign_source = 'link' AND c.campaign_at > NOW() - make_interval(days => $2::int) THEN 'links'
                    WHEN c.campaign_source = 'broadcast' AND c.campaign_at > NOW() - make_interval(days => $2::int) THEN 'broadcasts'
                    WHEN c.ad_source_id IS NULL AND c.campaign_source IS NULL AND c.created_at > NOW() - make_interval(days => $2::int) THEN 'organic'
               END AS source,
               COALESCE(CASE WHEN c.campaign_source IN ('link', 'broadcast') THEN c.campaign_at END, c.created_at) AS since
          FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
         WHERE cu.company_id = $1
      )
      SELECT source, COUNT(DISTINCT cu)::int AS people,
             COUNT(DISTINCT cu) FILTER (WHERE lead_stage = 'lost')::int AS lost,
             (SELECT COUNT(*) FROM bot_order o JOIN conv x ON x.cu = o.bot_channel_user_id AND x.source = conv.source
               WHERE o.status::text <> 'Cancelled' AND o.created_at >= x.since AND o.created_at < x.since + make_interval(days => $3::int))::int AS orders,
             (SELECT COALESCE(SUM(o.total_amount), 0) FROM bot_order o JOIN conv x ON x.cu = o.bot_channel_user_id AND x.source = conv.source
               WHERE o.status::text <> 'Cancelled' AND o.created_at >= x.since AND o.created_at < x.since + make_interval(days => $3::int)) AS revenue,
             (SELECT COUNT(*) FROM bot_booking b JOIN conv x ON x.cu = b.bot_channel_user_id AND x.source = conv.source
               WHERE LOWER(b.status) NOT IN ('cancelled', 'rejected') AND b.created_at >= x.since AND b.created_at < x.since + make_interval(days => $3::int))::int AS bookings
        FROM conv WHERE source IS NOT NULL GROUP BY source`, [companyId, days, ATTRIBUTION_DAYS]).catch(() => []);
    const src = (key: string) => {
      const row = sourceRows.find((r) => r.source === key) ?? {};
      return { people: num(row.people), orders: num(row.orders), bookings: num(row.bookings), revenue: num(row.revenue), lost: num(row.lost), spend: null as number | null };
    };
    const sources = {
      ads: ads ? { people: ads.totals.people, orders: ads.totals.orders, bookings: ads.totals.bookings, revenue: ads.totals.revenue, lost: ads.totals.lost, spend: ads.totals.spend } : src('ads'),
      links: src('links'), broadcasts: src('broadcasts'), organic: src('organic'),
    };
    const settings = await this.settings(companyId);
    return {
      sources,
      top_ads: (ads?.ads ?? []).slice(0, 5).map((a) => ({ ad_id: a.ad_id, headline: a.headline || a.ad_name, media_url: a.media_url, type: a.type, people: a.people, won: a.won, lost: a.lost, revenue: a.revenue, spend: a.spend })),
      ad_leads: ads ? { replied: ads.totals.replied, no_answer: ads.totals.no_answer, interested: ads.totals.interested, won: ads.totals.won, lost: ads.totals.lost, new_contacts: ads.totals.new_contacts } : null,
      setup: {
        whatsapp_cloud: channel?.provider_type === 'meta' && Boolean(channel?.meta_phone_number_id),
        ads_connected: Boolean(settings.meta_user_token), ad_account_name: settings.ad_account_name, capi_enabled: Boolean(settings.capi_enabled),
        active_links: num(links?.active), active_campaigns: num(campaigns?.active),
      },
      days,
      whatsapp_cloud: channel?.provider_type === 'meta' && Boolean(channel?.meta_phone_number_id),
      broadcasts: {
        count: broadcasts.length, sent, delivered: sum('delivered'), read: sum('read'), replied: sum('replied'), failed: sum('failed'),
        read_rate: sent ? Math.round((sum('read') / sent) * 100) : 0, reply_rate: sent ? Math.round((sum('replied') / sent) * 100) : 0,
        recent: broadcasts.slice(0, 5).map((b) => ({ ...b, stats: stats.get(Number(b.id)) ?? MarketingService.EMPTY_STATS })),
      },
      links: { active: num(links?.active), clicks: num(links?.clicks) },
      campaigns: { active: num(campaigns?.active), total: num(campaigns?.total) },
      chats: { from_ads: num(chats?.from_ads), from_links: num(chats?.from_links), from_campaigns: num(chats?.from_campaigns) },
      audience: { reachable: num(audience?.reachable), opted_out: num(audience?.opted_out), opted_out_period: num(audience?.opted_out_period) },
      daily,
    };
  }

  /** WhatsApp contacts that match the audience and did not opt out. */
  private async audienceContacts(companyId: number, audience: Audience): Promise<Array<{ id: number; phone: string; name: string }>> {
    const rows: Array<{ id: number; phone: string; name: string }> = await this.dataSource.query(`
      SELECT cu.id, cu.external_user_id AS phone, COALESCE(NULLIF(cu.display_name, ''), '') AS name
        FROM bot_channel_user cu
        LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN LATERAL (SELECT lead_stage FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) lc ON TRUE
       WHERE cu.company_id = $1 AND cu.platform = 'whatsapp' AND cu.external_user_id ~ '^[0-9+]{9,16}$'
         AND NOT EXISTS (SELECT 1 FROM marketing_optout o WHERE o.company_id = $1 AND o.bot_channel_user_id = cu.id)
         AND (COALESCE(array_length($2::text[], 1), 0) = 0 OR COALESCE(cc.tags, '{}') && $2::text[])
         AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR NOT (COALESCE(cc.tags, '{}') && $3::text[]))
         AND ($4::text IS NULL OR COALESCE(lc.lead_stage, 'new') = $4)
       ORDER BY cu.id`,
      [companyId, (audience.tags ?? []).map((t) => t.toLowerCase()), (audience.exclude_tags ?? []).map((t) => t.toLowerCase()), audience.stage || null]);
    // WhatsApp needs international numbers (0771234567 → 94771234567); one message per number
    const seen = new Set<string>();
    return rows
      .map((row) => ({ ...row, phone: normalisePhone(row.phone) }))
      .filter((row) => row.phone && !seen.has(row.phone) && seen.add(row.phone));
  }

  async audiencePreview(user: AuthenticatedUser, audience: Audience) {
    const companyId = await this.adminCompany(user);
    const rows = await this.audienceContacts(companyId, audience);
    const [optouts] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM marketing_optout WHERE company_id = $1`, [companyId]);
    return { count: rows.length, sample: rows.slice(0, 5), opted_out: num(optouts?.n) };
  }

  async createBroadcast(user: AuthenticatedUser, dto: { name: string; template_name: string; template_language: string; body_params?: string[]; audience?: Audience; scheduled_at?: string | null; send_now?: boolean; campaign_id?: number | null }) {
    const companyId = await this.adminCompany(user);
    if (dto.campaign_id) {
      const [campaign] = await this.dataSource.query(`SELECT 1 FROM marketing_campaign WHERE id = $1 AND company_id = $2`, [dto.campaign_id, companyId]);
      if (!campaign) throw new BadRequestException('Campaign not found.');
    }
    await this.cloudChannel(companyId);
    const templates = await this.templates(user);
    const template = templates.find((t) => t.name === dto.template_name && t.language === dto.template_language);
    if (!template) throw new BadRequestException('Choose an approved template.');
    if (template.sample) {
      throw new BadRequestException(`“${template.name}” is Meta's sample template – it only works from Meta's test number, so every message would fail. Create your own template in Marketing → Message templates (usually approved in minutes) and use that.`);
    }
    if (template.has_media_header) throw new BadRequestException('Templates with a photo / video header are not supported yet – use a text template.');
    const params = (dto.body_params ?? []).map((p) => String(p ?? '').trim());
    if (params.length !== template.variables || params.some((p) => !p)) throw new BadRequestException(`This template needs ${template.variables} value(s).`);
    const contacts = await this.audienceContacts(companyId, dto.audience ?? {});
    if (!contacts.length) throw new BadRequestException('No WhatsApp contacts match this audience.');
    // package limit: broadcast messages per calendar month (queued + sent)
    const perMonth = this.planService ? (await this.planService.limitsForCompany(companyId)).numbers.broadcasts_per_month : null;
    if (perMonth != null) {
      const [used] = await this.dataSource.query(`
        SELECT COUNT(*)::int AS n FROM marketing_broadcast_recipient r JOIN marketing_broadcast b ON b.id = r.broadcast_id
         WHERE b.company_id = $1
           AND (r.status IN ('queued', 'sending') OR (r.status = 'sent' AND r.sent_at >= date_trunc('month', NOW())))`, [companyId]);
      const left = Math.max(0, perMonth - num(used?.n));
      if (contacts.length > left) {
        throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'LIMIT_REACHED', feature: 'broadcasts_per_month',
          message: `Your package allows ${perMonth.toLocaleString()} broadcast messages per month – ${left.toLocaleString()} left, this broadcast needs ${contacts.length.toLocaleString()}. Choose a smaller group or upgrade.` });
      }
    }
    const scheduled = dto.send_now ? new Date() : dto.scheduled_at ? new Date(dto.scheduled_at) : null;
    if (scheduled && Number.isNaN(scheduled.getTime())) throw new BadRequestException('scheduled_at must be a date.');
    const [broadcast] = await this.dataSource.query(`
      INSERT INTO marketing_broadcast (company_id, name, template_name, template_language, body_params, audience, status, scheduled_at, total, created_by, campaign_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) RETURNING *`,
      [companyId, dto.name.trim(), template.name, template.language, JSON.stringify(params), JSON.stringify({ ...(dto.audience ?? {}), template_body: template.body }),
        scheduled ? 'scheduled' : 'draft', scheduled, contacts.length, user.id, dto.campaign_id ?? null]);
    for (let i = 0; i < contacts.length; i += 500) {
      const chunk = contacts.slice(i, i + 500);
      await this.dataSource.query(`
        INSERT INTO marketing_broadcast_recipient (broadcast_id, bot_channel_user_id, phone, name)
        SELECT $1, x.id, x.phone, x.name FROM jsonb_to_recordset($2::jsonb) AS x(id int, phone text, name text)`,
        [broadcast.id, JSON.stringify(chunk)]);
    }
    return this.broadcast(user, Number(broadcast.id));
  }

  async scheduleBroadcast(user: AuthenticatedUser, id: number, when: string | null) {
    const companyId = await this.adminCompany(user);
    const date = when ? new Date(when) : new Date();
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date.');
    const result = await this.dataSource.query(`UPDATE marketing_broadcast SET status = 'scheduled', scheduled_at = $3 WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'scheduled')`, [id, companyId, date]);
    if (!(Array.isArray(result) ? result[1] : 0)) throw new BadRequestException('Only drafts or scheduled broadcasts can be scheduled.');
    return this.broadcast(user, id);
  }

  async cancelBroadcast(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    await this.dataSource.query(`UPDATE marketing_broadcast SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'scheduled', 'sending')`, [id, companyId]);
    await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'skipped' WHERE broadcast_id = $1 AND status = 'queued'`, [id]);
    return this.broadcast(user, id);
  }

  /** Delivery numbers for several broadcasts in one query (a "failed after sending" counts only as failed). */
  private async statsFor(ids: number[]): Promise<Map<number, Record<string, number>>> {
    const out = new Map<number, Record<string, number>>();
    if (!ids.length) return out;
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT r.broadcast_id,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE r.status IN ('queued', 'sending'))::int AS queued,
             COUNT(*) FILTER (WHERE r.status = 'sent' AND COALESCE(m.delivery_status, '') <> 'failed')::int AS sent,
             COUNT(*) FILTER (WHERE r.status = 'sent' AND m.delivery_status IN ('delivered', 'read'))::int AS delivered,
             COUNT(*) FILTER (WHERE r.status = 'sent' AND m.delivery_status = 'read')::int AS read,
             COUNT(*) FILTER (WHERE r.status = 'failed' OR (r.status = 'sent' AND m.delivery_status = 'failed'))::int AS failed,
             COUNT(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
             COUNT(*) FILTER (WHERE r.status = 'sent' AND EXISTS (
               SELECT 1 FROM bot_conversation c JOIN bot_message x ON x.conversation_id = c.id
                WHERE c.bot_channel_user_id = r.bot_channel_user_id AND x.direction::text = 'inbound' AND x.created_at > r.sent_at))::int AS replied
        FROM marketing_broadcast_recipient r LEFT JOIN bot_message m ON m.id = r.message_id
       WHERE r.broadcast_id = ANY($1::int[]) GROUP BY r.broadcast_id`, [ids]);
    for (const row of rows) {
      const { broadcast_id: id, ...stats } = row;
      out.set(Number(id), Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, num(value)])));
    }
    return out;
  }

  private static readonly EMPTY_STATS = { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0 };

  async broadcasts(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT b.*, mc.name AS campaign_name FROM marketing_broadcast b LEFT JOIN marketing_campaign mc ON mc.id = b.campaign_id
       WHERE b.company_id = $1 ORDER BY b.id DESC LIMIT 100`, [companyId]);
    const stats = await this.statsFor(rows.map((row) => Number(row.id)));
    return rows.map((row) => ({ ...row, stats: stats.get(Number(row.id)) ?? MarketingService.EMPTY_STATS }));
  }

  async broadcast(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    const [row] = await this.dataSource.query(`SELECT * FROM marketing_broadcast WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Broadcast not found.');
    const stats = (await this.statsFor([id])).get(id) ?? MarketingService.EMPTY_STATS;
    const failed: Array<{ phone: string; name: string; error: string }> = await this.dataSource.query(`
      SELECT r.phone, r.name, COALESCE(r.error, 'failed') AS error FROM marketing_broadcast_recipient r LEFT JOIN bot_message m ON m.id = r.message_id
       WHERE r.broadcast_id = $1 AND (r.status = 'failed' OR (r.status = 'sent' AND m.delivery_status = 'failed')) ORDER BY r.id LIMIT 50`, [id]);
    const failures = failed.map((f) => { const why = explainWhatsAppError(f.error); return { ...f, error: why.text, fix: why.fix, code: why.code, raw_error: f.error }; });
    // the same reason for (almost) everyone → one clear headline with the fix
    const reasons = new Map<string, number>();
    for (const f of failures) reasons.set(f.error, (reasons.get(f.error) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    const main = top && top[1] >= Math.max(2, failures.length * 0.6) ? failures.find((f) => f.error === top[0]) : null;
    return { ...row, stats, failures, main_problem: main ? { text: main.error, fix: main.fix, count: top[1] } : null };
  }

  /** Sends queued recipients of due broadcasts, 25 per broadcast every 15 s. */
  private async sendBroadcasts() {
    // a batch stuck in 'sending' (server restarted mid-send): we cannot know if it went out
    await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'failed', error = 'interrupted (server restart) – may not have been sent' WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes'`);
    const due = await this.dataSource.query(`SELECT * FROM marketing_broadcast WHERE status IN ('scheduled', 'sending') AND scheduled_at <= NOW() ORDER BY id LIMIT 5`);
    for (const broadcast of due) {
      if (broadcast.status === 'scheduled') await this.dataSource.query(`UPDATE marketing_broadcast SET status = 'sending', started_at = NOW() WHERE id = $1`, [broadcast.id]);
      let channel: { meta_phone_number_id: string; meta_access_token: string };
      try {
        channel = await this.cloudChannel(Number(broadcast.company_id));
      } catch (error) {
        await this.dataSource.query(`UPDATE marketing_broadcast SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [broadcast.id, error instanceof Error ? error.message : 'WhatsApp not connected']);
        continue;
      }
      // claim a batch (safe with more than one API server: each row is taken only once)
      const claimed = await this.dataSource.query(`
        UPDATE marketing_broadcast_recipient SET status = 'sending', updated_at = NOW()
         WHERE id IN (SELECT id FROM marketing_broadcast_recipient WHERE broadcast_id = $1 AND status = 'queued' ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [broadcast.id]);
      const recipients = (Array.isArray(claimed[0]) ? claimed[0] : claimed) as Array<Record<string, any>>;
      for (const recipient of recipients) {
        const [state] = await this.dataSource.query(`SELECT status FROM marketing_broadcast WHERE id = $1`, [broadcast.id]);
        if (state?.status !== 'sending') {
          // cancelled while this batch was going out
          await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'skipped', error = 'cancelled' WHERE id = $1 AND status = 'sending'`, [recipient.id]);
          continue;
        }
        const [optedOut] = await this.dataSource.query(`SELECT 1 FROM marketing_optout WHERE company_id = $1 AND bot_channel_user_id = $2`, [broadcast.company_id, recipient.bot_channel_user_id]);
        if (optedOut) { await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'skipped', error = 'opted out' WHERE id = $1`, [recipient.id]); continue; }
        if (isTestPhone(recipient.phone)) { await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'skipped', error = 'test customer (simulator)' WHERE id = $1`, [recipient.id]); continue; }
        const firstName = String(recipient.name || '').split(/\s+/)[0] || 'there';
        const params = (broadcast.body_params as string[]).map((p) => p.replace(/\{name\}/gi, recipient.name || firstName).replace(/\{first_name\}/gi, firstName).replace(/\{phone\}/gi, recipient.phone));
        try {
          const result = await graphRequest<{ messages?: Array<{ id: string }> }>('POST', `/${channel.meta_phone_number_id}/messages`, channel.meta_access_token, {
            messaging_product: 'whatsapp', to: recipient.phone, type: 'template',
            template: { name: broadcast.template_name, language: { code: broadcast.template_language },
              ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}) },
          });
          const providerId = result.messages?.[0]?.id ?? null;
          // the message is out – a problem saving the chat copy must not mark it as failed
          const messageId = await this.saveBroadcastMessage(Number(recipient.bot_channel_user_id), broadcast, params, providerId).catch((error: unknown) => {
            this.logger.warn(`broadcast ${broadcast.id}: chat copy not saved: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'sent', provider_message_id = $2, message_id = $3, sent_at = NOW() WHERE id = $1`, [recipient.id, providerId, messageId]);
        } catch (error) {
          await this.dataSource.query(`UPDATE marketing_broadcast_recipient SET status = 'failed', error = $2 WHERE id = $1`, [recipient.id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
        }
      }
      const [left] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM marketing_broadcast_recipient WHERE broadcast_id = $1 AND status IN ('queued', 'sending')`, [broadcast.id]);
      if (!num(left?.n)) await this.dataSource.query(`UPDATE marketing_broadcast SET status = 'done', finished_at = NOW() WHERE id = $1 AND status = 'sending'`, [broadcast.id]);
    }
  }

  /** The template also appears in the customer's chat (and gets delivery / read ticks from the status webhook). */
  private async saveBroadcastMessage(channelUserId: number, broadcast: Record<string, any>, params: string[], providerId: string | null): Promise<number | null> {
    let conversation = await this.conversationRepository.findOne({ where: { bot_channel_user_id: channelUserId }, order: { id: 'DESC' } });
    if (!conversation) {
      conversation = await this.conversationRepository.save(this.conversationRepository.create({ bot_channel_user_id: channelUserId, status: 'open', last_message_at: new Date() } as Partial<BotConversation>));
    }
    let text = String(broadcast.audience?.template_body ?? '') || `[template ${broadcast.template_name}]`;
    params.forEach((value, index) => { text = text.split(`{{${index + 1}}}`).join(value); });
    const saved = await this.messageRepository.save(this.messageRepository.create({
      conversation_id: conversation.id, direction: 'outbound', message_type: 'text', platform: 'whatsapp', content: text,
      source: 'broadcast', provider_message_id: providerId, delivery_status: providerId ? 'sent' : null,
    } as Partial<BotMessage>));
    return saved.id;
  }

  /**
   * New customer messages (every channel, also the QR WhatsApp): STOP → opt-out, and campaign links
   * ("#slug" / the short-link text, waiting Messenger refs, replies to a campaign broadcast).
   */
  private async scanInbound() {
    const last = await this.cursor('optouts', `SELECT COALESCE(MAX(id), 0) AS id FROM bot_message`);
    const rows: Array<{ id: number; content: string | null; conversation_id: number; channel_user_id: number; company_id: number; first: boolean }> = await this.dataSource.query(`
      SELECT m.id, m.content, m.conversation_id, cu.id AS channel_user_id, cu.company_id,
             NOT EXISTS (SELECT 1 FROM bot_message p WHERE p.conversation_id = m.conversation_id AND p.direction::text = 'inbound' AND p.id < m.id) AS first
        FROM bot_message m
        JOIN bot_conversation c ON c.id = m.conversation_id JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
       WHERE m.id > $1 AND m.direction::text = 'inbound' ORDER BY m.id LIMIT 500`, [last]);
    const seen = new Set<number>();
    for (const row of rows) {
      const text = String(row.content ?? '');
      if (STOP.test(text)) {
        await this.dataSource.query(`INSERT INTO marketing_optout (company_id, bot_channel_user_id, reason) VALUES ($1, $2, 'stop') ON CONFLICT DO NOTHING`, [row.company_id, row.channel_user_id]);
      }
      try {
        let linked = false;
        if (row.first || linkTags(text).length) linked = await attributeText(this.dataSource, Number(row.conversation_id), Number(row.company_id), text);
        if (!seen.has(Number(row.conversation_id))) {
          seen.add(Number(row.conversation_id));
          if (!linked) linked = await applyPendingRefs(this.dataSource, Number(row.conversation_id));
          if (!linked) await attributeBroadcastReply(this.dataSource, Number(row.conversation_id));
        }
      } catch (error) {
        this.logger.warn(`campaign link for message ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rows.length) await this.moveCursor('optouts', Number(rows[rows.length - 1].id));
  }

  async setOptOut(user: AuthenticatedUser, contactId: number, optedOut: boolean) {
    const companyId = await this.adminCompany(user);
    const [contact] = await this.dataSource.query(`SELECT id FROM bot_channel_user WHERE id = $1 AND company_id = $2`, [contactId, companyId]);
    if (!contact) throw new NotFoundException('Contact not found.');
    if (optedOut) await this.dataSource.query(`INSERT INTO marketing_optout (company_id, bot_channel_user_id, reason) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`, [companyId, contactId]);
    else await this.dataSource.query(`DELETE FROM marketing_optout WHERE company_id = $1 AND bot_channel_user_id = $2`, [companyId, contactId]);
    return { contact_id: contactId, opted_out: optedOut };
  }

  /* ═══════════════ 6) Custom audiences ═══════════════ */

  async audiences(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    return this.dataSource.query(`SELECT * FROM marketing_audience WHERE company_id = $1 ORDER BY id DESC`, [companyId]);
  }

  /** CRM group → Meta Custom Audience (phone and email are SHA-256 hashed before they leave the server). */
  async createAudience(user: AuthenticatedUser, dto: { name: string; filters?: Audience }) {
    const companyId = await this.adminCompany(user);
    const { token, account } = await this.adsToken(companyId);
    const rows: Array<{ phone: string | null; email: string | null }> = await this.dataSource.query(`
      SELECT COALESCE(cc.phone, CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END) AS phone, cc.email
        FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
        LEFT JOIN LATERAL (SELECT lead_stage FROM bot_conversation c WHERE c.bot_channel_user_id = cu.id ORDER BY c.id DESC LIMIT 1) lc ON TRUE
       WHERE cu.company_id = $1
         AND (COALESCE(array_length($2::text[], 1), 0) = 0 OR COALESCE(cc.tags, '{}') && $2::text[])
         AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR NOT (COALESCE(cc.tags, '{}') && $3::text[]))
         AND ($4::text IS NULL OR COALESCE(lc.lead_stage, 'new') = $4)`,
      [companyId, (dto.filters?.tags ?? []).map((t) => t.toLowerCase()), (dto.filters?.exclude_tags ?? []).map((t) => t.toLowerCase()), dto.filters?.stage || null]);
    const data = rows
      .map((row) => [normalisePhone(row.phone), String(row.email ?? '').trim().toLowerCase()])
      .filter(([phone, email]) => phone || email)
      .map(([phone, email]) => [phone ? sha256(phone) : '', email ? sha256(email) : '']);
    if (data.length < 1) throw new BadRequestException('No contacts with a phone number or email match this group.');
    const [saved] = await this.dataSource.query(`INSERT INTO marketing_audience (company_id, name, filters, size, status) VALUES ($1, $2, $3::jsonb, $4, 'syncing') RETURNING id`,
      [companyId, dto.name.trim(), JSON.stringify(dto.filters ?? {}), data.length]);
    try {
      const audience = await graphRequest<{ id: string }>('POST', `/${account}/customaudiences`, token, {
        name: `Agent Metra – ${dto.name.trim()}`, subtype: 'CUSTOM', description: 'Customers from Agent Metra CRM', customer_file_source: 'USER_PROVIDED_ONLY',
      });
      for (let i = 0; i < data.length; i += 5000) {
        await graphRequest('POST', `/${audience.id}/users`, token, { payload: { schema: ['PHONE', 'EMAIL'], data: data.slice(i, i + 5000) } });
      }
      await this.dataSource.query(`UPDATE marketing_audience SET meta_audience_id = $2, status = 'ready', synced_at = NOW() WHERE id = $1`, [saved.id, audience.id]);
    } catch (error) {
      await this.dataSource.query(`UPDATE marketing_audience SET status = 'failed', error = $2 WHERE id = $1`, [saved.id, error instanceof Error ? error.message : String(error)]);
      this.graphError(error);
    }
    const [row] = await this.dataSource.query(`SELECT * FROM marketing_audience WHERE id = $1`, [saved.id]);
    return row;
  }

  /* ═══════════════ background ═══════════════ */

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.scanInbound();
      await this.sendBroadcasts();
      await this.sendConversions();
    } catch (error) {
      this.logger.warn(`marketing tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** for tests */
  async runOnce() { await this.tick(); }
}
