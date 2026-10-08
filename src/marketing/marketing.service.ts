import { PlanService } from '../platform/plan.service';
import { isTestPhone } from '../common/test-phone';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotConversation } from '../bot-admin/entities/bot-conversation.entity';
import { BotMessage } from '../bot-admin/entities/bot-message.entity';
import { MarketingHook } from '../common/marketing-hook';
import { applyPendingRefs, attributeAd, attributeBroadcastReply, attributeRef, attributeText, linkTags, savePendingRef } from './attribution';
import {
  GraphError, adsLoginUrl, exchangeAdsCode, fromMinorUnits, graphRequest, normalisePhone, readAdsState, sha256, toMinorUnits,
} from './graph';

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/** whole-message opt-out words (English, Singlish, Sinhala, Tamil) */
const STOP = /^\s*(stop|unsubscribe|opt[\s-]?out|stop promotions|stop messages|nawaththanna|nawattanna|නවත්වන්න|නතර කරන්න|niruththu|நிறுத்து|நிறுத்தவும்)\s*[.!]*\s*$/iu;
const ATTRIBUTION_DAYS = 28;

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
    const payload = root as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, any>> } }>; messaging?: Array<Record<string, any>> }> };
    type Found = { mid?: string; senderId?: string; kind: 'ad' | 'ref' | 'text'; value: string; type?: string; headline?: string; body?: string; url?: string; clid?: string | null };
    const found: Found[] = [];
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          const r = message.referral;
          if (r?.source_id) {
            found.push({ mid: message.id, kind: 'ad', value: String(r.source_id), type: String(r.source_type ?? 'ad'), headline: String(r.headline ?? ''),
              body: String(r.body ?? ''), url: String(r.source_url ?? ''), clid: r.ctwa_clid ? String(r.ctwa_clid) : null });
          }
          const text = String(message.text?.body ?? '');
          if (text && linkTags(text).length) found.push({ mid: message.id, kind: 'text', value: text });
        }
      }
      for (const event of entry.messaging ?? []) {
        const r = event.referral ?? event.message?.referral ?? event.postback?.referral;
        const senderId = event.sender?.id ? String(event.sender.id) : undefined;
        if (r && (r.ad_id || r.source === 'ADS')) {
          found.push({ mid: event.message?.mid, senderId, kind: 'ad', value: String(r.ad_id ?? r.ref ?? 'unknown'), type: 'ad',
            headline: String(r.ads_context_data?.ad_title ?? ''), body: '', url: String(r.ads_context_data?.photo_url ?? ''), clid: null });
        } else if (r?.ref) {
          found.push({ mid: event.message?.mid, senderId, kind: 'ref', value: String(r.ref) });
        }
        const text = String(event.message?.text ?? '');
        if (text && linkTags(text).length) found.push({ mid: event.message?.mid, senderId, kind: 'text', value: text });
      }
    }
    for (const ref of found) {
      let conversation: { id: number; company_id: number } | null = null;
      if (ref.mid) {
        const [row] = await this.dataSource.query(`
          SELECT m.conversation_id AS id, cu.company_id FROM bot_message m JOIN bot_conversation c ON c.id = m.conversation_id
            JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE m.provider_message_id = $1 OR m.provider_message_id LIKE $1 || ':%' ORDER BY m.id LIMIT 1`, [ref.mid]);
        conversation = row ? { id: Number(row.id), company_id: Number(row.company_id) } : null;
      }
      if (!conversation && ref.senderId) {
        const [row] = await this.dataSource.query(`
          SELECT c.id, cu.company_id FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
           WHERE cu.platform = $1 AND cu.external_user_id = $2 ORDER BY c.id DESC LIMIT 1`, [platform, ref.senderId]);
        conversation = row ? { id: Number(row.id), company_id: Number(row.company_id) } : null;
      }
      if (!conversation) {
        // a referral before the first message (new customer): keep it until the chat exists
        if (ref.senderId && ref.kind !== 'text') await savePendingRef(this.dataSource, platform, ref.senderId, { kind: ref.kind, value: ref.value, headline: ref.headline, body: ref.body, url: ref.url });
        continue;
      }
      if (ref.kind === 'text') { await attributeText(this.dataSource, conversation.id, conversation.company_id, ref.value); continue; }
      if (ref.kind === 'ref') { await attributeRef(this.dataSource, conversation.id, conversation.company_id, ref.value); continue; }
      // latest ad click wins for this chat
      await this.dataSource.query(`
        UPDATE bot_conversation SET ad_source_id = $2, ad_source_type = $3, ad_headline = $4, ad_source_url = $5,
               ad_ctwa_clid = COALESCE($6, ad_ctwa_clid), ad_platform = $7, ad_referred_at = NOW(), ad_body = $8
         WHERE id = $1`, [conversation.id, ref.value, ref.type ?? 'ad', String(ref.headline || ref.body || '').slice(0, 1000), String(ref.url ?? '').slice(0, 1000), ref.clid ?? null, platform, String(ref.body ?? '').slice(0, 2000)]);
      await this.resolveAdCampaign(conversation.company_id, ref.value).catch(() => undefined);
      await attributeAd(this.dataSource, conversation.id, conversation.company_id, ref.value);
    }
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
          { level: 'campaign', date_preset: preset, fields: 'campaign_id,spend,impressions,reach,clicks,actions', limit: '200' }),
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
          const started = actions.filter((a) => a.action_type.includes('messaging_conversation_started')).reduce((sum, a) => sum + num(a.value), 0);
          const spend = num(i.spend);
          const result = byCampaign.get(String(c.id)) ?? { chats: 0, orders: 0, revenue: 0, bookings: 0 };
          return {
            id: c.id, name: c.name, status: c.status, effective_status: c.effective_status, objective: c.objective,
            daily_budget: fromMinorUnits(c.daily_budget), lifetime_budget: fromMinorUnits(c.lifetime_budget),
            spend, impressions: num(i.impressions), reach: num(i.reach), clicks: num(i.clicks), conversations_started: started,
            chats: result.chats, orders: result.orders, bookings: result.bookings, revenue: result.revenue,
            cost_per_chat: result.chats ? spend / result.chats : null, cost_per_order: result.orders ? spend / result.orders : null,
            roas: spend > 0 ? result.revenue / spend : null,
          };
        }),
      };
    } catch (error) { this.graphError(error); }
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
        };
      });
    } catch (error) { this.graphError(error); }
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
    const failures = await this.dataSource.query(`
      SELECT r.phone, r.name, COALESCE(r.error, 'failed') AS error FROM marketing_broadcast_recipient r LEFT JOIN bot_message m ON m.id = r.message_id
       WHERE r.broadcast_id = $1 AND (r.status = 'failed' OR (r.status = 'sent' AND m.delivery_status = 'failed')) ORDER BY r.id LIMIT 50`, [id]);
    return { ...row, stats, failures };
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
