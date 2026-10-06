import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomInt } from 'crypto';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { graphRequest } from './graph';
import { MarketingService } from './marketing.service';

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const ATTRIBUTION_DAYS = 28;
export const CHANNELS = ['whatsapp', 'messenger', 'instagram'] as const;
export type LinkChannel = (typeof CHANNELS)[number];
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** words that would look like our own pages */
const RESERVED = new Set(['admin', 'api', 'login', 'app', 'www', 'help', 'support', 'billing']);

export type CampaignInput = {
  name: string; status?: 'active' | 'paused' | 'ended'; starts_at?: string | null; ends_at?: string | null;
  offer_text?: string; bot_instructions?: string; product_ids?: number[]; meta_campaign_ids?: string[]; meta_ad_ids?: string[]; tag?: string;
};
export type LinkInput = { name: string; channel: LinkChannel; target: string; prefill_text?: string; campaign_id?: number | null; slug?: string; tag?: string; is_active?: boolean };

const cleanTag = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 40);
const cleanIds = (values: unknown[] | undefined) => [...new Set((values ?? []).map((v) => String(v ?? '').trim()).filter((v) => /^\d{3,30}$/.test(v)))].slice(0, 100);
const dateOrNull = (value: string | null | undefined) => {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Dates must look like 2026-12-31.');
  return value;
};

/** Campaigns (ads + links + broadcasts with their own bot instructions) and short links / QR codes. */
@Injectable()
export class CampaignsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly marketing: MarketingService) {}

  /* ───────────── campaigns ───────────── */

  async campaigns(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.marketing.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT mc.*, mc.starts_at::text AS starts_at, mc.ends_at::text AS ends_at,
             (SELECT COUNT(*) FROM marketing_link l WHERE l.campaign_id = mc.id)::int AS links,
             (SELECT COALESCE(SUM(l.clicks), 0) FROM marketing_link l WHERE l.campaign_id = mc.id)::int AS clicks,
             (SELECT COUNT(*) FROM marketing_broadcast b WHERE b.campaign_id = mc.id)::int AS broadcasts
        FROM marketing_campaign mc WHERE mc.company_id = $1 ORDER BY (mc.status = 'active') DESC, mc.id DESC`, [companyId]);
    const results = await this.results(companyId, 'campaign_id', rows.map((row) => Number(row.id)), days);
    return rows.map((row) => ({ ...this.campaignView(row), ...(results.get(Number(row.id)) ?? { chats: 0, people: 0, orders: 0, revenue: 0 }) }));
  }

  private campaignView(row: Record<string, unknown>) {
    return {
      id: Number(row.id), name: row.name, status: row.status, starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null,
      offer_text: row.offer_text ?? '', bot_instructions: row.bot_instructions ?? '', product_ids: row.product_ids ?? [],
      meta_campaign_ids: row.meta_campaign_ids ?? [], meta_ad_ids: row.meta_ad_ids ?? [], tag: row.tag ?? '',
      links: num(row.links), clicks: num(row.clicks), broadcasts: num(row.broadcasts), created_at: row.created_at,
    };
  }

  /** chats, people, orders (28 days after the customer came) and revenue per campaign or link */
  private async results(companyId: number, column: 'campaign_id' | 'link_id', ids: number[], days: number) {
    const out = new Map<number, { chats: number; people: number; orders: number; revenue: number }>();
    if (!ids.length) return out;
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      WITH convs AS (
        SELECT c.id, c.bot_channel_user_id, c.${column} AS key, c.campaign_at
          FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id
         WHERE cu.company_id = $1 AND c.${column} = ANY($2::int[]) AND c.campaign_at > NOW() - make_interval(days => $3::int)
      ),
      orders AS (
        SELECT DISTINCT ON (o.id) o.id, o.total_amount, v.key
          FROM bot_order o JOIN convs v ON v.bot_channel_user_id = o.bot_channel_user_id
         WHERE o.created_at >= v.campaign_at AND o.created_at <= v.campaign_at + make_interval(days => $4::int)
           AND o.status::text <> 'Cancelled'
         ORDER BY o.id, v.campaign_at DESC
      )
      SELECT v.key, COUNT(*)::int AS chats, COUNT(DISTINCT v.bot_channel_user_id)::int AS people,
             (SELECT COUNT(*) FROM orders x WHERE x.key = v.key)::int AS orders,
             (SELECT COALESCE(SUM(x.total_amount), 0) FROM orders x WHERE x.key = v.key) AS revenue
        FROM convs v GROUP BY v.key`, [companyId, ids, days, ATTRIBUTION_DAYS]);
    for (const row of rows) out.set(Number(row.key), { chats: num(row.chats), people: num(row.people), orders: num(row.orders), revenue: num(row.revenue) });
    return out;
  }

  private async validProducts(companyId: number, ids: number[] | undefined): Promise<number[]> {
    const wanted = [...new Set((ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 20);
    if (!wanted.length) return [];
    const rows: Array<{ id: number }> = await this.dataSource.query(`SELECT id FROM product WHERE company_id = $1 AND id = ANY($2::int[]) AND COALESCE(is_deleted, FALSE) = FALSE`, [companyId, wanted]);
    return rows.map((row) => Number(row.id));
  }

  async createCampaign(user: AuthenticatedUser, dto: CampaignInput) {
    const companyId = await this.marketing.adminCompany(user);
    const starts = dateOrNull(dto.starts_at); const ends = dateOrNull(dto.ends_at);
    if (starts && ends && ends < starts) throw new BadRequestException('The end date is before the start date.');
    const [row] = await this.dataSource.query(`
      INSERT INTO marketing_campaign (company_id, name, status, starts_at, ends_at, offer_text, bot_instructions, product_ids, meta_campaign_ids, meta_ad_ids, tag, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12) RETURNING id`,
      [companyId, dto.name.trim(), dto.status ?? 'active', starts, ends, (dto.offer_text ?? '').trim(), (dto.bot_instructions ?? '').trim(),
        JSON.stringify(await this.validProducts(companyId, dto.product_ids)), JSON.stringify(cleanIds(dto.meta_campaign_ids)), JSON.stringify(cleanIds(dto.meta_ad_ids)),
        cleanTag(dto.tag) || cleanTag(dto.name), user.id]);
    return this.campaign(companyId, Number(row.id));
  }

  async updateCampaign(user: AuthenticatedUser, id: number, dto: Partial<CampaignInput>) {
    const companyId = await this.marketing.adminCompany(user);
    const current = await this.campaign(companyId, id);
    const starts = dto.starts_at === undefined ? current.starts_at as string | null : dateOrNull(dto.starts_at);
    const ends = dto.ends_at === undefined ? current.ends_at as string | null : dateOrNull(dto.ends_at);
    if (starts && ends && ends < starts) throw new BadRequestException('The end date is before the start date.');
    await this.dataSource.query(`
      UPDATE marketing_campaign SET name = $3, status = $4, starts_at = $5, ends_at = $6, offer_text = $7, bot_instructions = $8,
             product_ids = $9::jsonb, meta_campaign_ids = $10::jsonb, meta_ad_ids = $11::jsonb, tag = $12, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [id, companyId, (dto.name ?? current.name as string).trim(), dto.status ?? current.status, starts, ends,
        (dto.offer_text ?? current.offer_text as string).trim(), (dto.bot_instructions ?? current.bot_instructions as string).trim(),
        JSON.stringify(dto.product_ids !== undefined ? await this.validProducts(companyId, dto.product_ids) : current.product_ids),
        JSON.stringify(dto.meta_campaign_ids !== undefined ? cleanIds(dto.meta_campaign_ids) : current.meta_campaign_ids),
        JSON.stringify(dto.meta_ad_ids !== undefined ? cleanIds(dto.meta_ad_ids) : current.meta_ad_ids),
        dto.tag !== undefined ? cleanTag(dto.tag) : current.tag]);
    return this.campaign(companyId, id);
  }

  async deleteCampaign(user: AuthenticatedUser, id: number) {
    const companyId = await this.marketing.adminCompany(user);
    await this.campaign(companyId, id);
    // links and broadcasts stay (without a campaign); chats keep their history
    await this.dataSource.query(`UPDATE marketing_link SET campaign_id = NULL WHERE campaign_id = $1 AND company_id = $2`, [id, companyId]);
    await this.dataSource.query(`UPDATE marketing_broadcast SET campaign_id = NULL WHERE campaign_id = $1 AND company_id = $2`, [id, companyId]);
    await this.dataSource.query(`DELETE FROM marketing_campaign WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return { deleted: true };
  }

  private async campaign(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT *, starts_at::text AS starts_at, ends_at::text AS ends_at FROM marketing_campaign WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Campaign not found.');
    return this.campaignView(row);
  }

  /** Recent chats of a campaign (who came, from where) – for the campaign detail page. */
  async campaignChats(user: AuthenticatedUser, id: number) {
    const companyId = await this.marketing.adminCompany(user);
    await this.campaign(companyId, id);
    return this.dataSource.query(`
      SELECT c.id AS conversation_id, c.campaign_source AS source, c.campaign_at, cu.display_name AS name, cu.platform,
             CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END AS phone, l.name AS link_name, c.ad_headline
        FROM bot_conversation c JOIN bot_channel_user cu ON cu.id = c.bot_channel_user_id LEFT JOIN marketing_link l ON l.id = c.link_id
       WHERE cu.company_id = $1 AND c.campaign_id = $2 ORDER BY c.campaign_at DESC NULLS LAST LIMIT 100`, [companyId, id]);
  }

  /* ───────────── short links ───────────── */

  static shortBase(): string {
    const explicit = String(process.env.SHORT_LINK_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    for (const value of [process.env.PUBLIC_API_BASE_URL, process.env.API_PUBLIC_URL]) {
      try { if (value) return new URL(value).origin; } catch { /* next */ }
    }
    return `http://localhost:${process.env.PORT ?? 3001}`;
  }

  /** Where the short link sends the customer. WhatsApp gets "#slug" so we know which link was used. */
  static targetUrl(link: { channel: string; target: string; prefill_text: string; slug: string }): string {
    const slugTag = `#${link.slug}`;
    if (link.channel === 'messenger') return `https://m.me/${encodeURIComponent(link.target)}?ref=${encodeURIComponent(link.slug)}`;
    if (link.channel === 'instagram') return `https://ig.me/m/${encodeURIComponent(link.target.replace(/^@/, ''))}?ref=${encodeURIComponent(link.slug)}`;
    const text = link.prefill_text.toLowerCase().includes(slugTag) ? link.prefill_text : `${link.prefill_text.trim()} ${slugTag}`.trim();
    return `https://wa.me/${link.target.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
  }

  private linkView(row: Record<string, unknown>) {
    const base = CampaignsService.shortBase();
    return {
      id: Number(row.id), name: row.name, slug: row.slug, channel: row.channel, target: row.target, prefill_text: row.prefill_text,
      campaign_id: row.campaign_id === null ? null : Number(row.campaign_id), campaign_name: row.campaign_name ?? null, tag: row.tag ?? '',
      is_active: Boolean(row.is_active), clicks: num(row.clicks), created_at: row.created_at,
      short_url: `${base}/l/${row.slug}`,
      target_url: CampaignsService.targetUrl(row as { channel: string; target: string; prefill_text: string; slug: string }),
    };
  }

  async links(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.marketing.adminCompany(user);
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(`
      SELECT l.*, mc.name AS campaign_name FROM marketing_link l LEFT JOIN marketing_campaign mc ON mc.id = l.campaign_id
       WHERE l.company_id = $1 ORDER BY l.is_active DESC, l.id DESC`, [companyId]);
    const results = await this.results(companyId, 'link_id', rows.map((row) => Number(row.id)), days);
    return rows.map((row) => ({ ...this.linkView(row), ...(results.get(Number(row.id)) ?? { chats: 0, people: 0, orders: 0, revenue: 0 }) }));
  }

  private async newSlug(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const slug = Array.from({ length: 6 }, () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]).join('');
      const [taken] = await this.dataSource.query(`SELECT 1 FROM marketing_link WHERE slug = $1`, [slug]);
      if (!taken) return slug;
    }
    throw new ConflictException('Could not make a short link – try again.');
  }

  private async checkLinkInput(companyId: number, dto: Partial<LinkInput>) {
    if (dto.channel === 'whatsapp' && dto.target !== undefined) {
      const digits = dto.target.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) throw new BadRequestException('Enter the WhatsApp number with the country code, e.g. 94771234567.');
    }
    if ((dto.channel === 'messenger' || dto.channel === 'instagram') && dto.target !== undefined && !/^@?[A-Za-z0-9._-]{2,80}$/.test(dto.target.trim())) {
      throw new BadRequestException(dto.channel === 'messenger' ? 'Enter the Facebook Page username or Page ID.' : 'Enter the Instagram username.');
    }
    if (dto.campaign_id) {
      const [campaign] = await this.dataSource.query(`SELECT 1 FROM marketing_campaign WHERE id = $1 AND company_id = $2`, [dto.campaign_id, companyId]);
      if (!campaign) throw new BadRequestException('Campaign not found.');
    }
  }

  async createLink(user: AuthenticatedUser, dto: LinkInput) {
    const companyId = await this.marketing.adminCompany(user);
    await this.checkLinkInput(companyId, dto);
    let slug = String(dto.slug ?? '').trim().toLowerCase();
    if (slug) {
      if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || RESERVED.has(slug)) throw new BadRequestException('Short name: 3–32 letters, numbers or "-".');
      const [taken] = await this.dataSource.query(`SELECT 1 FROM marketing_link WHERE slug = $1`, [slug]);
      if (taken) throw new ConflictException('This short name is already used – choose another.');
    } else slug = await this.newSlug();
    const target = dto.channel === 'whatsapp' ? dto.target.replace(/\D/g, '') : dto.target.trim().replace(/^@/, '');
    const [row] = await this.dataSource.query(`
      INSERT INTO marketing_link (company_id, slug, name, channel, target, prefill_text, campaign_id, tag, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, slug, dto.name.trim(), dto.channel, target, (dto.prefill_text ?? '').trim().slice(0, 450), dto.campaign_id ?? null, cleanTag(dto.tag), user.id]);
    return this.link(companyId, Number(row.id));
  }

  async updateLink(user: AuthenticatedUser, id: number, dto: Partial<LinkInput>) {
    const companyId = await this.marketing.adminCompany(user);
    const current = await this.link(companyId, id);
    const channel = (dto.channel ?? current.channel) as LinkChannel;
    await this.checkLinkInput(companyId, { ...dto, channel, target: dto.target ?? (dto.channel ? String(current.target) : undefined) });
    const target = dto.target === undefined ? current.target : channel === 'whatsapp' ? dto.target.replace(/\D/g, '') : dto.target.trim().replace(/^@/, '');
    await this.dataSource.query(`
      UPDATE marketing_link SET name = $3, channel = $4, target = $5, prefill_text = $6, campaign_id = $7, tag = $8, is_active = $9, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [id, companyId, (dto.name ?? String(current.name)).trim(), channel, target, (dto.prefill_text ?? String(current.prefill_text)).trim().slice(0, 450),
        dto.campaign_id === undefined ? current.campaign_id : dto.campaign_id, dto.tag === undefined ? current.tag : cleanTag(dto.tag), dto.is_active ?? current.is_active]);
    return this.link(companyId, id);
  }

  async deleteLink(user: AuthenticatedUser, id: number) {
    const companyId = await this.marketing.adminCompany(user);
    await this.link(companyId, id);
    // printed QR codes may still exist: the link is switched off (shows "not active"), not reused
    await this.dataSource.query(`UPDATE marketing_link SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND company_id = $2`, [id, companyId]);
    return { deactivated: true };
  }

  private async link(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`
      SELECT l.*, mc.name AS campaign_name FROM marketing_link l LEFT JOIN marketing_campaign mc ON mc.id = l.campaign_id
       WHERE l.id = $1 AND l.company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Link not found.');
    return this.linkView(row);
  }

  /** Suggestions for a new link: the connected WhatsApp number, Facebook Page and Instagram username. */
  async linkDefaults(user: AuthenticatedUser) {
    const companyId = await this.marketing.adminCompany(user);
    const out: { whatsapp: string | null; messenger: Array<{ id: string; name: string }>; instagram: Array<{ username: string }>; short_base: string } = {
      whatsapp: null, messenger: [], instagram: [], short_base: CampaignsService.shortBase(),
    };
    const [channel] = await this.dataSource.query(`SELECT provider_type, meta_phone_number_id, meta_access_token FROM whatsapp_channels WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
    if (channel?.provider_type === 'meta' && channel.meta_phone_number_id && channel.meta_access_token) {
      const number = await graphRequest<{ display_phone_number?: string }>('GET', `/${channel.meta_phone_number_id}`, channel.meta_access_token, { fields: 'display_phone_number' }).catch(() => null);
      out.whatsapp = number?.display_phone_number ? number.display_phone_number.replace(/\D/g, '') : null;
    }
    const pages: Array<{ page_id: string; page_name: string; page_access_token: string; instagram_business_account_id: string | null }> = await this.dataSource.query(
      `SELECT page_id, page_name, page_access_token, instagram_business_account_id FROM meta_page_connections WHERE company_id = $1 AND status = 'active' ORDER BY id LIMIT 5`, [companyId]).catch(() => []);
    for (const page of pages) {
      out.messenger.push({ id: page.page_id, name: page.page_name });
      if (page.instagram_business_account_id) {
        const ig = await graphRequest<{ username?: string }>('GET', `/${page.instagram_business_account_id}`, page.page_access_token, { fields: 'username' }).catch(() => null);
        if (ig?.username) out.instagram.push({ username: ig.username });
      }
    }
    return out;
  }

  /** Public /l/:slug – counts the click and returns where to send the browser (null = unknown or switched off). */
  async open(slug: string, request: { ip?: string; userAgent?: string; referer?: string }): Promise<string | null> {
    const clean = String(slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(clean)) return null;
    const [link] = await this.dataSource.query(`SELECT id, channel, target, prefill_text, slug, is_active FROM marketing_link WHERE slug = $1`, [clean]);
    if (!link || !link.is_active) return null;
    const ipHash = request.ip ? createHash('sha256').update(`${request.ip}|${process.env.JWT_SECRET ?? ''}`).digest('hex').slice(0, 32) : null;
    await this.dataSource.query(`UPDATE marketing_link SET clicks = clicks + 1 WHERE id = $1`, [link.id]);
    await this.dataSource.query(`INSERT INTO marketing_link_click (link_id, ip_hash, user_agent, referer) VALUES ($1, $2, $3, $4)`,
      [link.id, ipHash, String(request.userAgent ?? '').slice(0, 300) || null, String(request.referer ?? '').slice(0, 300) || null]).catch(() => undefined);
    return CampaignsService.targetUrl(link);
  }

  /** Clicks per day for a link (last 30 days). */
  async linkClicks(user: AuthenticatedUser, id: number) {
    const companyId = await this.marketing.adminCompany(user);
    await this.link(companyId, id);
    return this.dataSource.query(`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Colombo'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS clicks
        FROM marketing_link_click WHERE link_id = $1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`, [id]);
  }
}
