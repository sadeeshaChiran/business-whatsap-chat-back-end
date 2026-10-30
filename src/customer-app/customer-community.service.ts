import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { publicChatMediaUrl, saveChatMedia } from '../bot-admin/chat-media.store';
import { PusherService } from '../common/pusher.service';
import { CustomerAppService } from './customer-app.service';
import { CONTACT_PHONES_SQL } from './customer-members.service';
import { CustomerDmService } from './customer-dm.service';
import { CustomerPushService } from './customer-push.service';
import type { CustomerAccount } from './customer-auth';

type Row = Record<string, any>;
type Upload = { buffer: Buffer; mimetype: string; originalname: string };

const MAX_TEXT = 4000;
const MAX_FILE_MB = 25;
const link = (key: string | null | undefined, hours = 6) => (key ? publicChatMediaUrl(key, hours * 3600) : null);
const clean = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};
/** UPDATE / DELETE … RETURNING come back as [rows, count] from TypeORM. */
const affected = (result: unknown) => (Array.isArray(result) && typeof result[1] === 'number' ? result[1] : Array.isArray(result) ? result.length : 0);

function imageOnly(file: Upload | null | undefined, maxMb = 10) {
  if (!file?.buffer?.length) return null;
  const mime = String(file.mimetype || '').split(';')[0].toLowerCase();
  if (!/^image\/(jpe?g|png|webp|gif)$/.test(mime)) throw new BadRequestException('Use a JPG, PNG, WEBP or GIF picture.');
  if (file.buffer.length > maxMb * 1024 * 1024) throw new BadRequestException(`The picture must be smaller than ${maxMb} MB.`);
  return { ...file, mimetype: mime };
}

/**
 * Customer app part 2 – a business's page in the app: its profile, News (posts), Groups (communities) and the customer's own
 * profile settings. Customers only see businesses they may open (CustomerAppService.place). Phone numbers are never shown to
 * other customers. Nothing here touches WhatsApp, Messenger, Instagram, TikTok or Telegram.
 */
@Injectable()
export class CustomerCommunityService implements OnModuleInit {
  private readonly pusher = new PusherService();

  private readonly logger = new Logger(CustomerCommunityService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly app: CustomerAppService, private readonly push: CustomerPushService) {}

  onModuleInit() {
    // a reply typed in the Inbox chat of a group → posted in the group
    this.app.groupDelivered = (companyId, groupId) => this.fromInbox(companyId, groupId);
  }

  /* ═════════════════════════ customer side ═════════════════════════ */

  /** Business header: name, logo, about, contact details, counts. */
  async profile(customer: CustomerAccount, companyId: number) {
    const place = await this.app.place(customer, companyId);
    const [p] = await this.dataSource.query(`SELECT * FROM ca_business_profile WHERE company_id = $1`, [companyId]);
    const [counts] = await this.dataSource.query(`
      SELECT (SELECT COUNT(*)::int FROM ca_news n WHERE n.company_id = $1 AND n.deleted_at IS NULL AND n.created_at > NOW() - INTERVAL '60 days'
                AND NOT EXISTS (SELECT 1 FROM ca_news_view v WHERE v.news_id = n.id AND v.account_id = $2)) AS news_unread,
             (SELECT COUNT(*)::int FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.archived_at IS NULL
                JOIN ca_group_message m ON m.group_id = g.id AND m.id > gm.last_read_id AND m.deleted_at IS NULL AND m.sender_account_id IS DISTINCT FROM gm.account_id
               WHERE gm.account_id = $2 AND g.company_id = $1) AS groups_unread,
             (SELECT COUNT(*)::int FROM ca_dm d JOIN ca_dm_message dm ON dm.dm_id = d.id AND dm.deleted_at IS NULL AND dm.sender_account_id <> $2
                 AND dm.id > CASE WHEN d.account_a = $2 THEN d.a_last_read_id ELSE d.b_last_read_id END
               WHERE d.company_id = $1 AND (d.account_a = $2 OR d.account_b = $2)) AS dms_unread,
             (SELECT COUNT(*)::int FROM bot_channel_user cu JOIN bot_conversation bc ON bc.bot_channel_user_id = cu.id
                JOIN bot_message m ON m.conversation_id = bc.id AND m.direction::text = 'outbound' AND m.message_type::text <> 'system' AND m.source IS DISTINCT FROM 'sms'
                LEFT JOIN ca_chat_state st ON st.channel_user_id = cu.id
               WHERE cu.company_id = $1 AND cu.platform = 'app' AND cu.external_user_id = 'ca:' || $2 AND m.created_at > COALESCE(st.last_read_at, 'epoch'::timestamptz)) AS chat_unread,
             EXISTS (SELECT 1 FROM ca_business_mute WHERE account_id = $2 AND company_id = $1) AS muted,
             (SELECT COALESCE(roles, '{}') FROM ca_app_member WHERE company_id = $1 AND phone = $3) AS roles`, [companyId, customer.id, customer.phone]);
    return {
      id: place.id, name: place.name, logo_url: link(p?.logo_key, 24), member_code: this.app.memberCode(companyId, customer.id), member_dm: place.member_dm,
      about: p?.about ?? null, address: p?.address ?? null, phone: p?.phone ?? null, hours: p?.hours ?? null, website: p?.website ?? null,
      news_unread: Number(counts?.news_unread ?? 0), groups_unread: Number(counts?.groups_unread ?? 0), muted: Boolean(counts?.muted),
      dms_unread: Number(counts?.dms_unread ?? 0), chat_unread: Number(counts?.chat_unread ?? 0), my_roles: counts?.roles ?? [], team_online: place.team_online,
    };
  }

  async setBusinessMuted(customer: CustomerAccount, companyId: number, muted: boolean) {
    await this.app.place(customer, companyId);
    if (muted) await this.dataSource.query(`INSERT INTO ca_business_mute (account_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [customer.id, companyId]);
    else await this.dataSource.query(`DELETE FROM ca_business_mute WHERE account_id = $1 AND company_id = $2`, [customer.id, companyId]);
    return { muted };
  }

  /** News of a business, pinned first, newest first; opening the list marks them seen. */
  async news(customer: CustomerAccount, companyId: number, beforeId?: number) {
    await this.app.place(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT n.id, n.title, n.body, n.media_key, n.pinned, n.created_at, n.updated_at,
             EXISTS (SELECT 1 FROM ca_news_view v WHERE v.news_id = n.id AND v.account_id = $2) AS seen
        FROM ca_news n WHERE n.company_id = $1 AND n.deleted_at IS NULL AND NOT n.pinned AND ($3::bigint IS NULL OR n.id < $3)
       ORDER BY n.id DESC LIMIT 30`, [companyId, customer.id, beforeId ?? null]);
    const pinned: Row[] = beforeId ? [] : await this.dataSource.query(`
      SELECT n.id, n.title, n.body, n.media_key, n.pinned, n.created_at, n.updated_at,
             EXISTS (SELECT 1 FROM ca_news_view v WHERE v.news_id = n.id AND v.account_id = $2) AS seen
        FROM ca_news n WHERE n.company_id = $1 AND n.deleted_at IS NULL AND n.pinned ORDER BY n.id DESC LIMIT 20`, [companyId, customer.id]);
    const hasMore = rows.length === 30;
    rows.unshift(...pinned);
    if (rows.length) {
      await this.dataSource.query(`
        INSERT INTO ca_news_view (news_id, account_id) SELECT UNNEST($1::bigint[]), $2 ON CONFLICT DO NOTHING`, [rows.map((r) => r.id), customer.id]);
    }
    return {
      has_more: hasMore,
      items: rows.map((r) => ({
        id: Number(r.id), title: r.title, body: r.body, image_url: link(r.media_key), pinned: Boolean(r.pinned), created_at: r.created_at,
        edited: new Date(r.updated_at).getTime() - new Date(r.created_at).getTime() > 60_000, new: !r.seen,
      })),
    };
  }

  /** My groups of this business + public groups I can join. Private groups are invisible to non-members. */
  async groups(customer: CustomerAccount, companyId: number) {
    await this.app.place(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT g.id, g.name, g.description, g.visibility, g.mode, g.show_members, gm.role, gm.muted, gm.last_read_id,
             (SELECT COUNT(*)::int FROM ca_group_member x WHERE x.group_id = g.id) AS members,
             last.text AS last_text, last.type AS last_type, last.created_at AS last_at,
             (SELECT COUNT(*)::int FROM ca_group_message m WHERE m.group_id = g.id AND m.deleted_at IS NULL AND gm.account_id IS NOT NULL
                AND m.id > gm.last_read_id AND m.sender_account_id IS DISTINCT FROM gm.account_id) AS unread
        FROM ca_group g
        LEFT JOIN ca_group_member gm ON gm.group_id = g.id AND gm.account_id = $2
        LEFT JOIN LATERAL (SELECT text, type, created_at FROM ca_group_message m WHERE m.group_id = g.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) last ON gm.account_id IS NOT NULL
       WHERE g.company_id = $1 AND g.archived_at IS NULL AND (gm.account_id IS NOT NULL OR g.visibility = 'public')
       ORDER BY (gm.account_id IS NULL), last.created_at DESC NULLS LAST, g.name`, [companyId, customer.id]);
    return rows.map((r) => ({
      id: Number(r.id), name: r.name, description: r.description, visibility: r.visibility, mode: r.mode, members: Number(r.members),
      joined: r.role != null, role: r.role ?? null, muted: Boolean(r.muted), unread: Number(r.unread ?? 0),
      last: r.last_at ? { text: r.last_type === 'image' ? '📷 Photo' : r.last_type === 'file' ? '📎 File' : String(r.last_text ?? '').slice(0, 120), at: r.last_at } : null,
    }));
  }

  private async group(customer: CustomerAccount, groupId: number, needMember = true) {
    const [g] = await this.dataSource.query(`
      SELECT g.*, gm.role, gm.muted, gm.last_read_id FROM ca_group g LEFT JOIN ca_group_member gm ON gm.group_id = g.id AND gm.account_id = $2
       WHERE g.id = $1 AND g.archived_at IS NULL`, [groupId, customer.id]);
    if (!g || (!g.role && g.visibility !== 'public')) throw new NotFoundException('This group was not found.');
    try {
      await this.app.place(customer, Number(g.company_id));
    } catch {
      throw new NotFoundException('This group was not found.');
    }
    if (needMember && !g.role) throw new ForbiddenException('Join the group first.');
    return g as Row;
  }

  async joinGroup(customer: CustomerAccount, groupId: number) {
    const g = await this.group(customer, groupId, false);
    if (g.role) return { joined: true };
    if (g.visibility !== 'public') throw new ForbiddenException('Only the business can add you to this group.');
    const [removed] = await this.dataSource.query(`SELECT 1 FROM ca_group_removed WHERE group_id = $1 AND account_id = $2`, [groupId, customer.id]);
    if (removed) throw new ForbiddenException('The business removed you from this group.');
    const [last] = await this.dataSource.query(`SELECT COALESCE(MAX(id), 0) AS id FROM ca_group_message WHERE group_id = $1`, [groupId]);
    await this.dataSource.query(`INSERT INTO ca_group_member (group_id, account_id, role, last_read_id) VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING`, [groupId, customer.id, Math.max(0, Number(last?.id ?? 0) - 20)]);
    return { joined: true };
  }

  async leaveGroup(customer: CustomerAccount, groupId: number) {
    await this.group(customer, groupId);
    await this.dataSource.query(`DELETE FROM ca_group_member WHERE group_id = $1 AND account_id = $2`, [groupId, customer.id]);
    return { left: true };
  }

  async setGroupMuted(customer: CustomerAccount, groupId: number, muted: boolean) {
    await this.group(customer, groupId);
    await this.dataSource.query(`UPDATE ca_group_member SET muted = $3 WHERE group_id = $1 AND account_id = $2`, [groupId, customer.id, muted]);
    return { muted };
  }

  /** How a sender is shown to other members: the business, a customer's name (if they allow it) – never a phone number. */
  private senderLabel(row: Row, companyName: string, viewerId: number, companyId: number) {
    if (row.sender_user_id || !row.sender_account_id) return { kind: 'business' as const, name: companyName };
    if (Number(row.sender_account_id) === viewerId) return { kind: 'me' as const, name: 'You' };
    if (!row.sender_exists) return { kind: 'member' as const, name: 'Deleted user' };
    const code = this.app.memberCode(companyId, Number(row.sender_account_id));
    return { kind: 'member' as const, name: row.show_name && row.sender_name ? String(row.sender_name) : `Member #${code}`, member: `m${row.sender_account_id}`, code };
  }

  async groupMessages(customer: CustomerAccount, groupId: number, beforeId?: number) {
    const g = await this.group(customer, groupId);
    const [company] = await this.dataSource.query(`
      SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS company_name, COALESCE(s.member_dm, FALSE) AS member_dm
        FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [g.company_id]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.*, a.name AS sender_name, a.show_name, (a.id IS NOT NULL) AS sender_exists
        FROM ca_group_message m LEFT JOIN ca_account a ON a.id = m.sender_account_id
       WHERE m.group_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
       ORDER BY m.id DESC LIMIT 40`, [groupId, beforeId ?? null]);
    const newest = rows[0]?.id ? Number(rows[0].id) : 0;
    if (!beforeId && newest > Number(g.last_read_id)) {
      await this.dataSource.query(`UPDATE ca_group_member SET last_read_id = GREATEST(last_read_id, $3) WHERE group_id = $1 AND account_id = $2`, [groupId, customer.id, newest]);
    }
    const seen = await this.readState(groupId);
    return {
      group: this.groupInfo(g, String(company?.company_name ?? '')),
      can_post: g.mode === 'chat' || g.role === 'admin',
      can_message_members: Boolean(company?.member_dm),
      has_more: rows.length === 40,
      messages: rows.reverse().map((m) => ({
        id: Number(m.id), type: m.type, deleted: Boolean(m.deleted_at),
        text: m.deleted_at ? '' : m.text, media_url: m.deleted_at ? null : link(m.media_key), created_at: m.created_at,
        sender: this.senderLabel(m, String(company?.company_name ?? 'Business'), customer.id, Number(g.company_id)),
        // my own messages: how many of the other members got / read it
        ...(Number(m.sender_account_id) === customer.id && !m.deleted_at ? { seen: seen(m) } : {}),
      })),
    };
  }

  /** For a message: members it went to (everyone but the sender), how many opened the app since, how many read it. */
  private async readState(groupId: number) {
    const members: Row[] = await this.dataSource.query(`
      SELECT gm.account_id, gm.last_read_id, a.last_active_at FROM ca_group_member gm JOIN ca_account a ON a.id = gm.account_id WHERE gm.group_id = $1`, [groupId]);
    return (m: Row) => {
      const others = members.filter((x) => Number(x.account_id) !== Number(m.sender_account_id ?? 0));
      const at = new Date(m.created_at).getTime();
      return {
        total: others.length,
        read: others.filter((x) => Number(x.last_read_id) >= Number(m.id)).length,
        delivered: others.filter((x) => Number(x.last_read_id) >= Number(m.id) || (x.last_active_at && new Date(x.last_active_at).getTime() >= at)).length,
      };
    };
  }

  private groupInfo(g: Row, companyName: string) {
    return {
      id: Number(g.id), company_id: Number(g.company_id), company_name: companyName, name: g.name, description: g.description,
      visibility: g.visibility, mode: g.mode, show_members: Boolean(g.show_members), role: g.role ?? null, muted: Boolean(g.muted),
    };
  }

  async postToGroup(customer: CustomerAccount, groupId: number, input: { text?: string; file?: Upload | null }) {
    const g = await this.group(customer, groupId);
    if (g.mode !== 'chat' && g.role !== 'admin') throw new ForbiddenException('Only admins can post in this group.');
    return this.saveGroupMessage(g, { accountId: customer.id }, input);
  }

  async deleteOwnGroupMessage(customer: CustomerAccount, groupId: number, messageId: number) {
    const g = await this.group(customer, groupId);
    const result = await this.dataSource.query(`
      UPDATE ca_group_message SET deleted_at = NOW() WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL
         AND (sender_account_id = $3 OR $4)`, [messageId, groupId, customer.id, g.role === 'admin']);
    if (!affected(result)) throw new NotFoundException('Message not found.');
    this.pingGroup(groupId, Number(g.company_id));
    return { deleted: true };
  }

  /** Members – only when the business allows it (or for group admins). Name (if they allow it) and member ID, never phone numbers. */
  async groupMembers(customer: CustomerAccount, groupId: number) {
    const g = await this.group(customer, groupId);
    const companyId = Number(g.company_id);
    const [settings] = await this.dataSource.query(`SELECT member_dm, dm_mode, dm_rules FROM ca_settings WHERE company_id = $1`, [companyId]);
    const byRoles = settings?.dm_mode === 'roles';
    const rules = (Array.isArray(settings?.dm_rules) ? settings.dm_rules : []) as Array<[string, string]>;
    // the business allowed member messages → people in the same group may message each other (the list is not needed for that)
    const dm = Boolean(settings?.member_dm);
    const fullList = Boolean(g.show_members) || g.role === 'admin';
    if (!fullList && !dm) throw new ForbiddenException('The business keeps the member list private.');
    const [mine] = await this.dataSource.query(`SELECT COALESCE(roles, '{}') AS roles FROM ca_app_member WHERE company_id = $1 AND phone = $2`, [companyId, customer.phone]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT a.id, a.name, a.show_name, a.avatar_key, a.allow_dm, a.last_active_at, a.show_last_seen, gm.role, COALESCE(am.roles, '{}') AS roles,
             EXISTS (SELECT 1 FROM ca_block b WHERE (b.account_id = $2 AND b.blocked_account_id = a.id) OR (b.account_id = a.id AND b.blocked_account_id = $2)) AS blocked
        FROM ca_group_member gm JOIN ca_account a ON a.id = gm.account_id
        LEFT JOIN ca_app_member am ON am.company_id = $3 AND am.phone = a.phone
       WHERE gm.group_id = $1 ORDER BY (gm.role = 'admin') DESC, a.name NULLS LAST LIMIT 500`, [groupId, customer.id, companyId]);
    const items = rows.map((r) => {
      const me = Number(r.id) === customer.id;
      const code = this.app.memberCode(companyId, Number(r.id));
      return {
        id: me ? 'me' : `m${r.id}`, me, role: r.role, code,
        name: me ? 'You' : r.show_name && r.name ? r.name : `Member #${code}`,
        avatar_url: r.show_name || me ? link(r.avatar_key, 24) : null,
        can_message: !me && dm && Boolean(r.allow_dm) && !r.blocked && (!byRoles || CustomerDmService.rolesAllowed(rules, mine?.roles ?? [], r.roles ?? [])),
        roles: r.roles ?? [],
        online: !me && r.show_last_seen !== false && r.last_active_at ? Date.now() - new Date(r.last_active_at).getTime() < 70_000 : false,
      };
    });
    // private member list: you see yourself and the people you may message
    return fullList ? items : items.filter((m) => m.me || m.can_message);
  }

  /* ───────── customer's own profile ───────── */

  async me(customer: CustomerAccount) {
    const [a] = await this.dataSource.query(`SELECT id, phone, name, avatar_key, show_name, allow_dm, show_last_seen FROM ca_account WHERE id = $1`, [customer.id]);
    return { id: Number(a.id), phone: a.phone, name: a.name, avatar_url: link(a.avatar_key, 24), show_name: Boolean(a.show_name), allow_dm: Boolean(a.allow_dm), show_last_seen: a.show_last_seen !== false };
  }

  async updateSettings(customer: CustomerAccount, input: { show_name?: boolean; allow_dm?: boolean; show_last_seen?: boolean }) {
    if (typeof input.show_last_seen === 'boolean') await this.dataSource.query(`UPDATE ca_account SET show_last_seen = $2 WHERE id = $1`, [customer.id, input.show_last_seen]);
    if (typeof input.show_name === 'boolean') await this.dataSource.query(`UPDATE ca_account SET show_name = $2 WHERE id = $1`, [customer.id, input.show_name]);
    if (typeof input.allow_dm === 'boolean') await this.dataSource.query(`UPDATE ca_account SET allow_dm = $2 WHERE id = $1`, [customer.id, input.allow_dm]);
    return this.me(customer);
  }

  async setAvatar(customer: CustomerAccount, file: Upload | null) {
    const image = imageOnly(file, 5);
    const key = image ? saveChatMedia(0, image.buffer, image.mimetype, image.originalname || 'avatar.jpg') : null;
    await this.dataSource.query(`UPDATE ca_account SET avatar_key = $2 WHERE id = $1`, [customer.id, key]);
    return this.me(customer);
  }

  /** Delete my account: logins end, groups left, my name removed from businesses' chats. The businesses keep their chat history. */
  async deleteAccount(customer: CustomerAccount) {
    await this.dataSource.transaction(async (db) => {
      await db.query(`DELETE FROM ca_group_member WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_news_view WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_business_mute WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_chat_state WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_push_sub WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_device_key WHERE account_id = $1`, [customer.id]);
      await db.query(`DELETE FROM ca_block WHERE account_id = $1 OR blocked_account_id = $1`, [customer.id]);
      await db.query(`UPDATE bot_channel_user SET display_name = 'Deleted customer', updated_at = NOW() WHERE platform = 'app' AND external_user_id = $1`, [`ca:${customer.id}`]);
      await db.query(`DELETE FROM ca_account WHERE id = $1`, [customer.id]);
    });
    return { deleted: true };
  }

  /* ═════════════════════════ business side ═════════════════════════ */

  async businessProfile(companyId: number) {
    const [p] = await this.dataSource.query(`SELECT * FROM ca_business_profile WHERE company_id = $1`, [companyId]);
    return { logo_url: link(p?.logo_key, 24), about: p?.about ?? null, address: p?.address ?? null, phone: p?.phone ?? null, hours: p?.hours ?? null, website: p?.website ?? null };
  }

  async saveBusinessProfile(companyId: number, input: Record<string, unknown>) {
    const website = clean(input.website, 200);
    if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) throw new BadRequestException('The website must start with https://');
    await this.dataSource.query(`
      INSERT INTO ca_business_profile (company_id, about, address, phone, hours, website, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (company_id) DO UPDATE SET about = EXCLUDED.about, address = EXCLUDED.address, phone = EXCLUDED.phone, hours = EXCLUDED.hours,
        website = EXCLUDED.website, updated_at = NOW()`,
    [companyId, clean(input.about, 1000), clean(input.address, 300), clean(input.phone, 40), clean(input.hours, 300), website]);
    return this.businessProfile(companyId);
  }

  async setLogo(companyId: number, file: Upload | null) {
    const image = imageOnly(file, 5);
    const key = image ? saveChatMedia(companyId, image.buffer, image.mimetype, image.originalname || 'logo.png') : null;
    await this.dataSource.query(`
      INSERT INTO ca_business_profile (company_id, logo_key, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (company_id) DO UPDATE SET logo_key = EXCLUDED.logo_key, updated_at = NOW()`, [companyId, key]);
    return this.businessProfile(companyId);
  }

  /* ───────── news ───────── */

  async businessNews(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT n.*, (SELECT COUNT(*)::int FROM ca_news_view v WHERE v.news_id = n.id) AS views
        FROM ca_news n WHERE n.company_id = $1 AND n.deleted_at IS NULL ORDER BY n.pinned DESC, n.id DESC LIMIT 100`, [companyId]);
    return rows.map((r) => ({ id: Number(r.id), title: r.title, body: r.body, image_url: link(r.media_key), pinned: r.pinned, views: Number(r.views), created_at: r.created_at }));
  }

  async postNews(companyId: number, userId: number, input: { title?: unknown; body?: unknown; pinned?: unknown }, file: Upload | null) {
    const title = clean(input.title, 120);
    const body = clean(input.body, 4000) ?? '';
    const image = imageOnly(file);
    if (!title && !body && !image) throw new BadRequestException('Write something or add a photo.');
    const key = image ? saveChatMedia(companyId, image.buffer, image.mimetype, image.originalname || 'news.jpg') : null;
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_news (company_id, title, body, media_key, pinned, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, title, body, key, input.pinned === true || input.pinned === 'true', userId]);
    void this.pushToMembers(companyId, { title: await this.appName(companyId), body: `📰 ${title || body || 'New photo'}`, target: { kind: 'news' }, tag: `${companyId}:news` }).catch(() => undefined);
    return { id: Number(row.id) };
  }

  async updateNews(companyId: number, newsId: number, input: { title?: unknown; body?: unknown; pinned?: unknown }) {
    const sets: string[] = [];
    const params: unknown[] = [newsId, companyId];
    if (input.title !== undefined) { params.push(clean(input.title, 120)); sets.push(`title = $${params.length}`); }
    if (input.body !== undefined) { params.push(clean(input.body, 4000) ?? ''); sets.push(`body = $${params.length}`); }
    if (input.pinned !== undefined) { params.push(input.pinned === true || input.pinned === 'true'); sets.push(`pinned = $${params.length}`); }
    if (!sets.length) return { updated: false };
    const result = await this.dataSource.query(`UPDATE ca_news SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, params);
    if (!affected(result)) throw new NotFoundException('News not found.');
    return { updated: true };
  }

  async deleteNews(companyId: number, newsId: number) {
    const result = await this.dataSource.query(`UPDATE ca_news SET deleted_at = NOW() WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [newsId, companyId]);
    if (!affected(result)) throw new NotFoundException('News not found.');
    return { deleted: true };
  }

  /* ───────── groups ───────── */

  private settings(input: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = clean(input.name, 80);
      if (!name) throw new BadRequestException('Give the group a name.');
      out.name = name;
    }
    if (input.description !== undefined) out.description = clean(input.description, 500);
    if (input.visibility !== undefined) out.visibility = input.visibility === 'public' ? 'public' : 'private';
    if (input.mode !== undefined) out.mode = input.mode === 'chat' ? 'chat' : 'announce';
    if (input.show_members !== undefined) out.show_members = input.show_members === true || input.show_members === 'true';
    return out;
  }

  async businessGroups(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT g.*, (SELECT COUNT(*)::int FROM ca_group_member gm WHERE gm.group_id = g.id) AS members,
             (SELECT COUNT(*)::int FROM ca_group_message m WHERE m.group_id = g.id AND m.deleted_at IS NULL) AS messages,
             (SELECT MAX(created_at) FROM ca_group_message m WHERE m.group_id = g.id) AS last_at
        FROM ca_group g WHERE g.company_id = $1 AND g.archived_at IS NULL ORDER BY g.created_at DESC`, [companyId]);
    return rows.map((g) => ({
      id: Number(g.id), name: g.name, description: g.description, visibility: g.visibility, mode: g.mode, show_members: g.show_members,
      members: Number(g.members), messages: Number(g.messages), last_at: g.last_at, created_at: g.created_at,
    }));
  }

  async createGroup(companyId: number, userId: number, input: Record<string, unknown>) {
    const s = this.settings({ name: input.name ?? '', ...input });
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_group (company_id, name, description, visibility, mode, show_members, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [companyId, s.name, s.description ?? null, s.visibility ?? 'private', s.mode ?? 'announce', s.show_members ?? false, userId]);
    return { id: Number(row.id) };
  }

  private async ownGroup(companyId: number, groupId: number) {
    const [g] = await this.dataSource.query(`SELECT * FROM ca_group WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`, [groupId, companyId]);
    if (!g) throw new NotFoundException('Group not found.');
    return g as Row;
  }

  async updateGroup(companyId: number, groupId: number, input: Record<string, unknown>) {
    await this.ownGroup(companyId, groupId);
    const s = this.settings(input);
    const keys = Object.keys(s);
    if (keys.length) {
      await this.dataSource.query(`UPDATE ca_group SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [groupId, companyId, ...keys.map((k) => s[k])]);
    }
    return { updated: true };
  }

  async archiveGroup(companyId: number, groupId: number) {
    await this.ownGroup(companyId, groupId);
    await this.dataSource.query(`UPDATE ca_group SET archived_at = NOW() WHERE id = $1`, [groupId]);
    return { deleted: true };
  }

  /** Members of a group. The business added these numbers itself, so it sees them in full. */
  async businessMembers(companyId: number, groupId: number) {
    await this.ownGroup(companyId, groupId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT a.id, COALESCE(a.name, am.name) AS name, a.phone, gm.role, gm.joined_at, (am.phone IS NOT NULL) AS member
        FROM ca_group_member gm JOIN ca_account a ON a.id = gm.account_id
        LEFT JOIN ca_app_member am ON am.company_id = $2 AND am.phone = a.phone
       WHERE gm.group_id = $1 ORDER BY (gm.role = 'admin') DESC, a.name NULLS LAST`, [groupId, companyId]);
    return rows.map((r) => ({
      account_id: Number(r.id), name: r.name || 'Customer', role: r.role, joined_at: r.joined_at, member_code: this.app.memberCode(companyId, Number(r.id)),
      phone: r.member ? `+${r.phone}` : `+${String(r.phone).slice(0, 4)}•••${String(r.phone).slice(-3)}`,
    }));
  }

  /** The business's app members who already use the app (to add them to groups by hand). */
  async appCustomers(companyId: number, search = '') {
    const q = `%${search.trim().toLowerCase()}%`;
    const rows: Row[] = await this.dataSource.query(`
      SELECT a.id, COALESCE(a.name, am.name) AS name, a.phone FROM ca_app_member am JOIN ca_account a ON a.phone = am.phone
       WHERE am.company_id = $1 AND am.joined_at IS NOT NULL AND ($2 = '%%' OR LOWER(COALESCE(a.name, am.name, '')) LIKE $2 OR a.phone LIKE $2)
       ORDER BY a.name NULLS LAST LIMIT 200`, [companyId, q]);
    return rows.map((r) => ({ account_id: Number(r.id), name: r.name || 'Customer', phone: `+${r.phone}` }));
  }

  /**
   * Add members: chosen app customers and / or everyone with these CRM tags who uses the app.
   * Only numbers on the business's app list can be added.
   */
  async addMembers(companyId: number, groupId: number, input: { account_ids?: unknown; tags?: unknown }) {
    await this.ownGroup(companyId, groupId);
    const ids = (Array.isArray(input.account_ids) ? input.account_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000);
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    if (!ids.length && !tags.length) throw new BadRequestException('Choose customers or tags.');
    const tagged: Row[] = tags.length ? await this.dataSource.query(`SELECT c.phone FROM (${CONTACT_PHONES_SQL}) c WHERE c.tags && $2::text[]`, [companyId, tags]) : [];
    const candidates: Row[] = await this.dataSource.query(`
      SELECT a.id FROM ca_account a JOIN ca_app_member am ON am.company_id = $1 AND am.phone = a.phone AND am.joined_at IS NOT NULL
       WHERE a.id = ANY($2::bigint[]) OR a.phone = ANY($3::text[])`, [companyId, ids, tagged.map((r) => String(r.phone))]);
    const [last] = await this.dataSource.query(`SELECT COALESCE(MAX(id), 0) AS id FROM ca_group_message WHERE group_id = $1`, [groupId]);
    let added = 0;
    for (const c of candidates) {
      const result = await this.dataSource.query(`
        INSERT INTO ca_group_member (group_id, account_id, role, last_read_id) VALUES ($1, $2, 'member', $3) ON CONFLICT DO NOTHING RETURNING account_id`,
      [groupId, c.id, Math.max(0, Number(last?.id ?? 0) - 20)]);
      added += affected(result) ? 1 : 0;
      await this.dataSource.query(`DELETE FROM ca_group_removed WHERE group_id = $1 AND account_id = $2`, [groupId, c.id]);
    }
    return { added, already: candidates.length - added, not_on_app: tags.length ? Math.max(0, tagged.length - candidates.length) : 0 };
  }

  async setMemberRole(companyId: number, groupId: number, accountId: number, role: string) {
    await this.ownGroup(companyId, groupId);
    const result = await this.dataSource.query(`UPDATE ca_group_member SET role = $3 WHERE group_id = $1 AND account_id = $2`, [groupId, accountId, role === 'admin' ? 'admin' : 'member']);
    if (!affected(result)) throw new NotFoundException('Member not found.');
    return { updated: true };
  }

  async removeMember(companyId: number, groupId: number, accountId: number) {
    await this.ownGroup(companyId, groupId);
    await this.dataSource.query(`DELETE FROM ca_group_member WHERE group_id = $1 AND account_id = $2`, [groupId, accountId]);
    await this.dataSource.query(`INSERT INTO ca_group_removed (group_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, accountId]);
    return { removed: true };
  }

  async businessGroupMessages(companyId: number, groupId: number, beforeId?: number) {
    const g = await this.ownGroup(companyId, groupId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.*, a.name AS sender_name, u.name AS staff_name FROM ca_group_message m
        LEFT JOIN ca_account a ON a.id = m.sender_account_id LEFT JOIN app_user u ON u.id = m.sender_user_id
       WHERE m.group_id = $1 AND ($2::bigint IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT 50`, [groupId, beforeId ?? null]);
    const seen = await this.readState(groupId);
    return {
      group: { id: Number(g.id), name: g.name, mode: g.mode },
      has_more: rows.length === 50,
      messages: rows.reverse().map((m) => ({
        ...(m.sender_user_id && !m.deleted_at ? { seen: seen(m) } : {}),
        id: Number(m.id), type: m.type, text: m.deleted_at ? '' : m.text, media_url: m.deleted_at ? null : link(m.media_key), deleted: Boolean(m.deleted_at),
        created_at: m.created_at, from_business: Boolean(m.sender_user_id), sender: m.sender_user_id ? String(m.staff_name ?? 'Team') : String(m.sender_name ?? 'Customer'),
      })),
    };
  }

  async businessPost(companyId: number, userId: number, groupId: number, input: { text?: string; file?: Upload | null }) {
    const g = await this.ownGroup(companyId, groupId);
    return this.saveGroupMessage(g, { userId }, input);
  }

  async businessDeleteMessage(companyId: number, groupId: number, messageId: number) {
    await this.ownGroup(companyId, groupId);
    const result = await this.dataSource.query(`UPDATE ca_group_message SET deleted_at = NOW() WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`, [messageId, groupId]);
    if (!affected(result)) throw new NotFoundException('Message not found.');
    this.pingGroup(groupId, companyId);
    return { deleted: true };
  }

  /* ───────── shared ───────── */

  private async saveGroupMessage(g: Row, from: { accountId?: number; userId?: number }, input: { text?: string; file?: Upload | null }) {
    const text = String(input.text ?? '').trim();
    if (text.length > MAX_TEXT) throw new BadRequestException(`A message can have up to ${MAX_TEXT} characters.`);
    let type = 'text';
    let key: string | null = null;
    let body = text;
    const file = input.file?.buffer?.length ? input.file : null;
    if (file) {
      const mime = String(file.mimetype || 'application/octet-stream').split(';')[0].toLowerCase();
      if (file.buffer.length > MAX_FILE_MB * 1024 * 1024) throw new BadRequestException(`Files can be up to ${MAX_FILE_MB} MB.`);
      if (/^(text\/html|image\/svg|application\/(x-)?javascript)/.test(mime)) throw new BadRequestException('This kind of file can not be sent.');
      key = saveChatMedia(Number(g.company_id), file.buffer, mime, file.originalname || 'file');
      if (mime.startsWith('image/')) type = 'image';
      else { type = 'file'; body = [file.originalname || 'file', text].filter(Boolean).join('\n'); }
    }
    if (!body && !key) throw new BadRequestException('Type a message.');
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_group_message (group_id, sender_account_id, sender_user_id, type, text, media_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [g.id, from.accountId ?? null, from.userId ?? null, type, body, key]);
    if (from.accountId) await this.dataSource.query(`UPDATE ca_group_member SET last_read_id = $3 WHERE group_id = $1 AND account_id = $2`, [g.id, from.accountId, row.id]);
    this.pingGroup(Number(g.id), Number(g.company_id));
    void this.pushGroup(g, from, type === 'image' ? '📷 Photo' : type === 'file' ? '📎 File' : body).catch(() => undefined);
    void this.toInbox(g, Number(row.id), from, type, body, key).catch((error) => this.logger.warn(`group → inbox failed: ${error instanceof Error ? error.message : String(error)}`));
    return { id: Number(row.id), created_at: row.created_at };
  }

  /* ───────── groups in the business Inbox ───────── */

  /** The group's chat in the Inbox (one per group, the AI bot never answers it). */
  private async groupInboxUser(g: Row): Promise<Row> {
    const external = `cag:${g.id}`;
    const [existing] = await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [g.company_id, external]);
    if (existing) {
      if (existing.display_name !== `${g.name} · group`) await this.dataSource.query(`UPDATE bot_channel_user SET display_name = $2 WHERE id = $1`, [existing.id, `${g.name} · group`]);
      return existing;
    }
    const [created] = await this.dataSource.query(`
      INSERT INTO bot_channel_user (company_id, app_user_id, platform, external_user_id, source_account_id, display_name, language, language_locked, session_state, bot_enabled, manual_mode, last_seen_at, created_at, updated_at)
      VALUES ($1, NULL, 'app', $2, NULL, $3, 'English', false, NULL, false, true, NOW(), NOW(), NOW())
      ON CONFLICT DO NOTHING RETURNING *`, [g.company_id, external, `${g.name} · group`]);
    return created ?? (await this.dataSource.query(`SELECT * FROM bot_channel_user WHERE company_id = $1 AND platform = 'app' AND external_user_id = $2`, [g.company_id, external]))[0];
  }

  /** Every group message also shows in the group's Inbox chat: "Name: message" (the team sees real names). */
  private async toInbox(g: Row, groupMessageId: number, from: { accountId?: number; userId?: number; fromInbox?: boolean }, type: string, body: string, key: string | null) {
    if (from.fromInbox) return;
    const user = await this.groupInboxUser(g);
    const conversation = await this.app.conversation(Number(user.id));
    const companyId = Number(g.company_id);
    let content = body;
    let direction: 'inbound' | 'outbound' = 'outbound';
    if (from.accountId) {
      direction = 'inbound';
      const [a] = await this.dataSource.query(`
        SELECT COALESCE(am.name, a.name, 'Member') AS name FROM ca_account a LEFT JOIN ca_app_member am ON am.company_id = $2 AND am.phone = a.phone WHERE a.id = $1`, [from.accountId, companyId]);
      const who = `${a?.name ?? 'Member'} (#${this.app.memberCode(companyId, from.accountId)})`;
      content = type === 'image' ? `${who}${body ? `: ${body}` : ''}` : `${who}: ${body}`;
    }
    const [m] = await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, media_url, source, sender_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, 'app', $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING id`,
    [conversation.id, direction, type === 'image' ? 'image' : 'text', `app:grp${groupMessageId}`, direction === 'outbound' ? 'sent' : null,
      content || (type === 'image' ? '[image]' : ''), key, direction === 'inbound' ? 'app-group' : 'app-group-staff', from.userId ?? null]);
    await this.dataSource.query(`UPDATE ca_group_message SET bot_message_id = $2 WHERE id = $1`, [groupMessageId, m.id]);
    await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`, [conversation.id]);
    this.app.notifyInbox(companyId, Number(conversation.id), direction, content);
  }

  /** Replies typed in the group's Inbox chat → posted in the group as the business. */
  async fromInbox(companyId: number, groupId: number) {
    const [g] = await this.dataSource.query(`SELECT * FROM ca_group WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`, [groupId, companyId]);
    if (!g) return;
    const user = await this.groupInboxUser(g);
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.* FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
       WHERE bc.bot_channel_user_id = $1 AND m.direction::text = 'outbound' AND m.message_type::text <> 'system'
         AND COALESCE(m.source, '') <> 'app-group-staff' AND m.created_at > NOW() - INTERVAL '1 hour'
         AND NOT EXISTS (SELECT 1 FROM ca_group_message x WHERE x.bot_message_id = m.id)
       ORDER BY m.id`, [user.id]);
    for (const m of rows) {
      const type = m.message_type === 'image' ? 'image' : m.media_url ? 'file' : 'text';
      const [row] = await this.dataSource.query(`
        INSERT INTO ca_group_message (group_id, sender_account_id, sender_user_id, type, text, media_key, bot_message_id)
        SELECT $1, NULL, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM ca_group_message WHERE bot_message_id = $6) RETURNING id`,
      [groupId, m.sender_user_id ?? null, type, type === 'image' && m.content === '[image]' ? '' : String(m.content ?? ''), m.media_url ?? null, m.id]);
      if (!row) continue;
      this.pingGroup(groupId, companyId);
      void this.pushGroup(g, { userId: Number(m.sender_user_id ?? 0) || -1 }, type === 'image' ? '📷 Photo' : type === 'file' ? '📎 File' : String(m.content ?? '')).catch(() => undefined);
    }
  }

  private async appName(companyId: number) {
    const [row] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    return String(row?.name ?? 'Business');
  }

  /** Everyone on the business's app list who has the app. */
  private async pushToMembers(companyId: number, message: Parameters<CustomerPushService['notify']>[2]) {
    const rows: Row[] = await this.dataSource.query(`SELECT a.id FROM ca_app_member am JOIN ca_account a ON a.phone = am.phone WHERE am.company_id = $1`, [companyId]);
    this.push.notify(rows.map((r) => Number(r.id)), companyId, message);
  }

  /** New group message → the other members (who did not mute the group). */
  private async pushGroup(g: Row, from: { accountId?: number; userId?: number }, text: string) {
    const companyId = Number(g.company_id);
    const rows: Row[] = await this.dataSource.query(`
      SELECT gm.account_id, a.name, a.show_name FROM ca_group_member gm JOIN ca_account a ON a.id = gm.account_id WHERE gm.group_id = $1`, [g.id]);
    const sender = from.accountId ? rows.find((r) => Number(r.account_id) === from.accountId) : null;
    const who = from.userId ? await this.appName(companyId) : sender?.show_name && sender?.name ? String(sender.name) : `Member #${this.app.memberCode(companyId, Number(from.accountId))}`;
    this.push.notify(rows.map((r) => Number(r.account_id)).filter((id) => id !== from.accountId), companyId, {
      title: String(g.name), body: `${who}: ${text}`, target: { kind: 'group', id: Number(g.id) }, groupId: Number(g.id),
    });
  }

  /** Members' apps listen on the group's channel (only members may subscribe). */
  private pingGroup(groupId: number, companyId: number) {
    this.pusher.trigger(`private-ca-group-${groupId}`, 'message', { group_id: groupId, company_id: companyId });
  }
}
