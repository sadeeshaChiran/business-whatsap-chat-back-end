import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { publicChatMediaUrl, readChatMedia } from '../bot-admin/chat-media.store';
import { normalizeWhatsapp } from '../verification/verification';

type Row = Record<string, any>;
/** rows of INSERT … RETURNING, or of UPDATE / DELETE … RETURNING (TypeORM gives [rows, count] for those) */
const returned = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []) as Row[];

/** A business's contacts that have a phone number (WhatsApp chats and CRM contacts), one row per number. */
export const CONTACT_PHONES_SQL = `
  SELECT DISTINCT ON (x.phone) x.channel_user_id, x.name, x.phone, x.tags FROM (
    SELECT cu.id AS channel_user_id, COALESCE(NULLIF(cu.display_name, ''), 'Customer') AS name,
           ca_norm_phone(COALESCE(NULLIF(cc.phone, ''), CASE WHEN cu.platform = 'whatsapp' THEN cu.external_user_id END)) AS phone,
           COALESCE(cc.tags, '{}') AS tags, cu.id AS sort
      FROM bot_channel_user cu LEFT JOIN crm_contact cc ON cc.bot_channel_user_id = cu.id
     WHERE cu.company_id = $1 AND cu.platform <> 'app') x
   WHERE x.phone ~ '^\\d{9,15}$'
   ORDER BY x.phone, x.sort DESC`;

const MAX_ADD = 20000;

/**
 * Customer app part 3 – each business's own app: its public face (name, logo, home-screen icon, install manifest) and the list
 * of numbers that may use it ("app members"), with who already has the app and who does not.
 */
@Injectable()
export class CustomerMembersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /* ───────────────────────── public: the business's app ───────────────────────── */

  private async bySlug(slug: string): Promise<Row> {
    const value = String(slug ?? '').trim().toLowerCase();
    const [row] = /^[a-z0-9-]{3,40}$/.test(value) ? await this.dataSource.query(`
      SELECT s.*, c.company_name, p.logo_key, p.about FROM ca_settings s JOIN companies c ON c.id = s.company_id
        LEFT JOIN ca_business_profile p ON p.company_id = s.company_id
       WHERE s.slug = $1 AND s.enabled`, [value]) : [];
    if (!row) throw new NotFoundException('This app was not found. Ask the business for its link again.');
    return row;
  }

  private iconVersion(row: Row) {
    return createHash('sha1').update(String(row.icon_key ?? row.logo_key ?? 'default')).digest('hex').slice(0, 10);
  }

  /** What the login screen shows before anyone logs in: the business's name, logo and colour. Nothing private. */
  async appInfo(slug: string) {
    const row = await this.bySlug(slug);
    const name = String(row.app_name || row.company_name);
    return {
      company_id: Number(row.company_id), slug: String(row.slug), name, business_name: String(row.company_name),
      logo_url: row.logo_key ? publicChatMediaUrl(row.logo_key, 24 * 3600) : null,
      has_icon: Boolean(row.icon_key || row.logo_key), icon_version: this.iconVersion(row),
      theme_color: row.theme_color || '#6d4dff', about: row.about ?? null, access: row.access === 'link' ? 'link' : 'invited', member_dm: Boolean(row.member_dm),
    };
  }

  /** The web addresses the app may be opened from (same list as CORS). Any address when none is set (local testing). */
  private appOrigin(requested?: string) {
    const list = [process.env.CORS_ORIGINS ?? '', process.env.APP_PUBLIC_URL ?? '']
      .join(',').split(',').map((v) => v.trim().replace(/\/+$/, '')).filter(Boolean);
    const asked = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(requested ?? '')) ? String(requested) : '';
    if (asked && (!list.length || list.includes(asked))) return asked;
    return (process.env.APP_PUBLIC_URL ?? list[0] ?? '').trim().replace(/\/+$/, '');
  }

  /** "Add to Home Screen": the business's own name and icon, opening straight into its app. */
  async manifest(slug: string, origin?: string) {
    const row = await this.bySlug(slug);
    const base = this.appOrigin(origin);
    const name = String(row.app_name || row.company_name);
    const color = row.theme_color || '#6d4dff';
    const v = this.iconVersion(row);
    const own = row.icon_key || row.logo_key;
    const icons = own
      ? [
        { src: `icon.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `icon.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `icon.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
      : [
        { src: `${base}/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${base}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `${base}/icons/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
    return {
      id: `/app/${row.slug}/`, name, short_name: Array.from(name).slice(0, 12).join(''),
      description: row.about ? String(row.about).slice(0, 200) : `Chat with ${name}`,
      start_url: `${base}/app/${row.slug}/`, scope: `${base}/app/${row.slug}/`,
      display: 'standalone', orientation: 'portrait', background_color: '#ffffff', theme_color: color, icons,
    };
  }

  /** The icon file (PNG made from the logo when the business uploaded it; else the logo itself). */
  async icon(slug: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const row = await this.bySlug(slug);
    const file = (row.icon_key && readChatMedia(row.icon_key)) || (row.logo_key && readChatMedia(row.logo_key)) || null;
    return file ? { buffer: file.buffer, contentType: file.contentType } : null;
  }

  /* ───────────────────────── business: who may use the app ───────────────────────── */

  /** Added numbers, with who has the app / turned notifications on. */
  async members(companyId: number, query: { status?: string; q?: string; page?: number }) {
    const status = ['on_app', 'not_on_app'].includes(String(query.status)) ? String(query.status) : 'all';
    const search = String(query.q ?? '').trim().toLowerCase();
    const digits = search.replace(/\D/g, '');
    const page = Math.max(1, Number(query.page) || 1);
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.phone, COALESCE(m.name, CASE WHEN m.joined_at IS NOT NULL THEN a.name END) AS name, m.source, m.added_at, m.joined_at, m.last_open_at,
             (m.joined_at IS NOT NULL) AS on_app,
             (m.joined_at IS NOT NULL AND EXISTS (SELECT 1 FROM ca_push_sub p WHERE p.account_id = a.id AND (p.company_id IS NULL OR p.company_id = $1))) AS push,
             COUNT(*) OVER() AS total
        FROM ca_app_member m LEFT JOIN ca_account a ON a.phone = m.phone
       WHERE m.company_id = $1
         AND ($2 = 'all' OR ($2 = 'on_app' AND m.joined_at IS NOT NULL) OR ($2 = 'not_on_app' AND m.joined_at IS NULL))
         AND ($3 = '' OR LOWER(COALESCE(m.name, '')) LIKE '%' || $3 || '%' OR ($4 <> '' AND (m.phone LIKE '%' || $4 || '%' OR ca_norm_phone($4) = m.phone)))
       ORDER BY (m.joined_at IS NULL), m.last_open_at DESC NULLS LAST, m.added_at DESC
       LIMIT 50 OFFSET $5`, [companyId, status, search, digits, (page - 1) * 50]);
    const [counts] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS added, COUNT(*) FILTER (WHERE m.joined_at IS NOT NULL)::int AS on_app,
             COUNT(*) FILTER (WHERE m.joined_at IS NOT NULL AND EXISTS (SELECT 1 FROM ca_push_sub p WHERE p.account_id = a.id AND (p.company_id IS NULL OR p.company_id = $1)))::int AS notifications
        FROM ca_app_member m LEFT JOIN ca_account a ON a.phone = m.phone WHERE m.company_id = $1`, [companyId]);
    const [contacts] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS contacts, COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ca_app_member m WHERE m.company_id = $1 AND m.phone = c.phone))::int AS not_added
        FROM (${CONTACT_PHONES_SQL}) c`, [companyId]);
    return {
      page, total: Number(rows[0]?.total ?? 0),
      counts: {
        added: Number(counts?.added ?? 0), on_app: Number(counts?.on_app ?? 0), not_on_app: Number(counts?.added ?? 0) - Number(counts?.on_app ?? 0),
        notifications: Number(counts?.notifications ?? 0), contacts: Number(contacts?.contacts ?? 0), contacts_not_added: Number(contacts?.not_added ?? 0),
      },
      items: rows.map((r) => ({
        phone: `+${r.phone}`, name: r.name || null, source: r.source, added_at: r.added_at, on_app: Boolean(r.on_app),
        joined_at: r.joined_at, last_open_at: r.last_open_at, notifications: Boolean(r.push),
      })),
    };
  }

  /** The business's contacts (to pick whom to add), with "already added" / "has the app". */
  async contacts(companyId: number, query: { q?: string; tag?: string; page?: number }) {
    const search = String(query.q ?? '').trim().toLowerCase();
    const digits = search.replace(/\D/g, '');
    const tag = String(query.tag ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(query.page) || 1);
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.*, (m.phone IS NOT NULL) AS added, (m.joined_at IS NOT NULL) AS on_app, COUNT(*) OVER() AS total
        FROM (${CONTACT_PHONES_SQL}) c
        LEFT JOIN ca_app_member m ON m.company_id = $1 AND m.phone = c.phone
       WHERE ($2 = '' OR LOWER(c.name) LIKE '%' || $2 || '%' OR ($3 <> '' AND c.phone LIKE '%' || $3 || '%'))
         AND ($4 = '' OR $4 = ANY(c.tags))
       ORDER BY (m.phone IS NOT NULL), c.name
       LIMIT 50 OFFSET $5`, [companyId, search, digits, tag, (page - 1) * 50]);
    const tags: Array<{ tag: string; n: number }> = await this.dataSource.query(
      `SELECT tag, COUNT(*)::int AS n FROM crm_contact, UNNEST(tags) AS tag WHERE company_id = $1 GROUP BY tag ORDER BY n DESC LIMIT 50`, [companyId]);
    return {
      page, total: Number(rows[0]?.total ?? 0), tags,
      items: rows.map((r) => ({ contact_id: Number(r.channel_user_id), name: r.name, phone: `+${r.phone}`, tags: r.tags ?? [], added: Boolean(r.added), on_app: Boolean(r.on_app) })),
    };
  }

  /**
   * Give numbers access: chosen contacts, everyone with some tags, all contacts, and / or typed numbers.
   * Only these numbers can log in to the business's app.
   */
  async addMembers(companyId: number, userId: number, input: { contact_ids?: unknown; tags?: unknown; all_contacts?: unknown; phones?: unknown }) {
    const ids = (Array.isArray(input.contact_ids) ? input.contact_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_ADD);
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const all = input.all_contacts === true || input.all_contacts === 'true';
    const typed = (Array.isArray(input.phones) ? input.phones : String(input.phones ?? '').split(/[,;\n]+/)).map((p) => String(p).trim()).filter(Boolean).slice(0, 2000);
    if (!ids.length && !tags.length && !all && !typed.length) throw new BadRequestException('Choose contacts, a tag or type numbers.');

    const bad: string[] = [];
    const phones = typed.map((p) => {
      const phone = normalizeWhatsapp(p);
      if (!/^\d{10,15}$/.test(phone)) bad.push(p);
      return phone;
    }).filter((p) => /^\d{10,15}$/.test(p));

    const result = await this.dataSource.query(`
      WITH picked AS (
        SELECT c.phone, c.name, 'contacts' AS source FROM (${CONTACT_PHONES_SQL}) c
         WHERE $5 OR c.channel_user_id = ANY($2::int[]) OR (COALESCE(array_length($3::text[], 1), 0) > 0 AND c.tags && $3::text[])
        UNION ALL
        SELECT p, NULL, 'manual' FROM UNNEST($4::text[]) AS p
      ), one AS (SELECT DISTINCT ON (phone) phone, name, source FROM picked ORDER BY phone, (name IS NULL))
      INSERT INTO ca_app_member (company_id, phone, name, source, added_by)
      SELECT $1, phone, name, source, $6 FROM one LIMIT ${MAX_ADD}
      ON CONFLICT (company_id, phone) DO NOTHING RETURNING phone`, [companyId, ids, tags, phones, all, userId]);
    const added = returned(result).length;
    // added again by the business → no longer "removed"
    if (added) await this.dataSource.query(`DELETE FROM ca_app_removed WHERE company_id = $1 AND phone = ANY($2::text[])`, [companyId, returned(result).map((r) => String(r.phone))]);
    return { added_now: added, invalid: bad.slice(0, 20), counts: (await this.members(companyId, {})).counts };
  }

  /** Take a number's access away: it can no longer open the app, and it leaves the business's groups. */
  async removeMember(companyId: number, rawPhone: string) {
    const phone = normalizeWhatsapp(rawPhone);
    const removed = await this.dataSource.query(`DELETE FROM ca_app_member WHERE company_id = $1 AND phone = $2 RETURNING phone`, [companyId, phone]);
    if (!returned(removed).length) throw new NotFoundException('This number is not in your app list.');
    await this.dataSource.query(`INSERT INTO ca_app_removed (company_id, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [companyId, phone]);
    await this.dataSource.query(`
      DELETE FROM ca_group_member gm USING ca_group g, ca_account a
       WHERE g.id = gm.group_id AND g.company_id = $1 AND a.id = gm.account_id AND a.phone = $2`, [companyId, phone]);
    return { removed: true };
  }
}
