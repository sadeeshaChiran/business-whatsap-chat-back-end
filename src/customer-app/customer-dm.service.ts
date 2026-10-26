import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { publicChatMediaUrl, saveChatMedia } from '../bot-admin/chat-media.store';
import { CustomerAppService } from './customer-app.service';
import type { CustomerAccount } from './customer-auth';
import { CustomerPushService } from './customer-push.service';

type Row = Record<string, any>;
type Upload = { buffer: Buffer; mimetype: string; originalname: string };

const MAX_TEXT = 4000;
const MAX_FILE_MB = 25;
const link = (key: string | null | undefined, hours = 6) => (key ? publicChatMediaUrl(key, hours * 3600) : null);
const returned = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []) as Row[];
const memberId = (value: string) => {
  const id = Number(/^m(\d+)$/.exec(String(value ?? ''))?.[1] ?? 0);
  if (!id) throw new BadRequestException('Choose a member.');
  return id;
};

/**
 * Member-to-member messages inside one business's app – only when the business turned it on (off by default), only between
 * members of a group that shows its member list, and never with someone who blocked you. Phone numbers are never shown: the
 * other person sees your name (if you allow it) or your member ID. Block and report (reports go to the business).
 */
@Injectable()
export class CustomerDmService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly app: CustomerAppService,
    private readonly push: CustomerPushService,
  ) {}

  private async dmOn(companyId: number) {
    const [row] = await this.dataSource.query(`SELECT member_dm FROM ca_settings WHERE company_id = $1`, [companyId]);
    return Boolean(row?.member_dm);
  }

  /** How the other member is shown to me. */
  private label(companyId: number, row: { id: number | string; name?: string | null; show_name?: boolean; avatar_key?: string | null } | null) {
    if (!row) return { name: 'Deleted user', avatar_url: null, code: null as string | null };
    const code = this.app.memberCode(companyId, Number(row.id));
    return { name: row.show_name && row.name ? String(row.name) : `Member #${code}`, avatar_url: row.show_name ? link(row.avatar_key, 24) : null, code };
  }

  /** Why I can't message this member (null = I can). */
  private async blockedReason(companyId: number, me: number, other: number): Promise<string | null> {
    if (me === other) return 'This is you.';
    const [row] = await this.dataSource.query(`
      SELECT a.allow_dm, (am.phone IS NOT NULL) AS member,
             EXISTS (SELECT 1 FROM ca_block b WHERE b.account_id = $2 AND b.blocked_account_id = a.id) AS i_blocked,
             EXISTS (SELECT 1 FROM ca_block b WHERE b.account_id = a.id AND b.blocked_account_id = $2) AS they_blocked,
             EXISTS (SELECT 1 FROM ca_group_member x JOIN ca_group g ON g.id = x.group_id AND g.archived_at IS NULL AND g.show_members AND g.company_id = $1
                       JOIN ca_group_member y ON y.group_id = x.group_id AND y.account_id = a.id WHERE x.account_id = $2) AS shared
        FROM ca_account a LEFT JOIN ca_app_member am ON am.company_id = $1 AND am.phone = a.phone WHERE a.id = $3`, [companyId, me, other]);
    if (!row || !row.member) return 'This member is no longer here.';
    if (row.i_blocked) return 'You blocked this member. Unblock them to send a message.';
    if (row.they_blocked || !row.allow_dm) return 'This member does not take messages.';
    if (!row.shared) return 'You can only message members of your groups.';
    return null;
  }

  /** My member chats in this business's app. */
  async list(customer: CustomerAccount, companyId: number) {
    const place = await this.app.place(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT d.id, d.last_message_at, o.id AS other_id, o.name, o.show_name, o.avatar_key,
             last.text AS last_text, last.type AS last_type, last.sender_account_id AS last_sender, last.deleted_at AS last_deleted,
             (SELECT COUNT(*)::int FROM ca_dm_message m WHERE m.dm_id = d.id AND m.deleted_at IS NULL AND m.sender_account_id <> $2
                AND m.id > CASE WHEN d.account_a = $2 THEN d.a_last_read_id ELSE d.b_last_read_id END) AS unread
        FROM ca_dm d
        LEFT JOIN ca_account o ON o.id = CASE WHEN d.account_a = $2 THEN d.account_b ELSE d.account_a END
        LEFT JOIN LATERAL (SELECT text, type, sender_account_id, deleted_at FROM ca_dm_message m WHERE m.dm_id = d.id ORDER BY m.id DESC LIMIT 1) last ON TRUE
       WHERE d.company_id = $1 AND (d.account_a = $2 OR d.account_b = $2) AND d.last_message_at IS NOT NULL
       ORDER BY d.last_message_at DESC LIMIT 200`, [companyId, customer.id]);
    return {
      enabled: place.member_dm,
      items: rows.map((r) => ({
        id: Number(r.id), member: r.other_id ? `m${r.other_id}` : null, ...this.label(companyId, r.other_id ? { id: r.other_id, name: r.name, show_name: r.show_name, avatar_key: r.avatar_key } : null),
        unread: Number(r.unread ?? 0), last_at: r.last_message_at,
        last: r.last_deleted ? 'Message deleted' : `${Number(r.last_sender) === customer.id ? 'You: ' : ''}${r.last_type === 'image' ? '📷 Photo' : r.last_type === 'file' ? '📎 File' : String(r.last_text ?? '').slice(0, 100)}`,
      })),
    };
  }

  /** Open (or start) a chat with a member of one of my groups. */
  async start(customer: CustomerAccount, companyId: number, member: string) {
    await this.app.place(customer, companyId);
    if (!(await this.dmOn(companyId))) throw new ForbiddenException('This business has not turned on messages between members.');
    const other = memberId(member);
    const why = await this.blockedReason(companyId, customer.id, other);
    if (why) throw new ForbiddenException(why);
    const [a, b] = customer.id < other ? [customer.id, other] : [other, customer.id];
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_dm (company_id, account_a, account_b, started_by) VALUES ($1, $2, $3, $4)
      ON CONFLICT (company_id, account_a, account_b) DO UPDATE SET company_id = EXCLUDED.company_id RETURNING id`, [companyId, a, b, customer.id]);
    return { id: Number(row.id) };
  }

  private async dm(customer: CustomerAccount, dmId: number) {
    const [d] = await this.dataSource.query(`SELECT * FROM ca_dm WHERE id = $1 AND (account_a = $2 OR account_b = $2)`, [dmId, customer.id]);
    if (!d) throw new NotFoundException('This chat was not found.');
    try {
      await this.app.place(customer, Number(d.company_id));
    } catch {
      throw new NotFoundException('This chat was not found.');
    }
    const otherId = Number(d.account_a) === customer.id ? Number(d.account_b) : Number(d.account_a);
    return { d: d as Row, otherId };
  }

  async messages(customer: CustomerAccount, dmId: number, beforeId?: number) {
    const { d, otherId } = await this.dm(customer, dmId);
    const companyId = Number(d.company_id);
    const [other] = await this.dataSource.query(`SELECT id, name, show_name, avatar_key FROM ca_account WHERE id = $1`, [otherId]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT * FROM ca_dm_message WHERE dm_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 40`, [dmId, beforeId ?? null]);
    const newest = rows[0]?.id ? Number(rows[0].id) : 0;
    const mineIsA = Number(d.account_a) === customer.id;
    if (!beforeId && newest > Number(mineIsA ? d.a_last_read_id : d.b_last_read_id)) {
      await this.dataSource.query(`UPDATE ca_dm SET ${mineIsA ? 'a_last_read_id' : 'b_last_read_id'} = GREATEST(${mineIsA ? 'a_last_read_id' : 'b_last_read_id'}, $2) WHERE id = $1`, [dmId, newest]);
    }
    const otherRead = Number(mineIsA ? d.b_last_read_id : d.a_last_read_id);
    const why = (await this.dmOn(companyId)) ? await this.blockedReason(companyId, customer.id, otherId) : 'This business turned off messages between members.';
    const [company] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    return {
      chat: { id: dmId, company_id: companyId, company_name: String(company?.name ?? ''), member: `m${otherId}`, ...this.label(companyId, other ?? null),
        blocked_by_me: Boolean((await this.dataSource.query(`SELECT 1 FROM ca_block WHERE account_id = $1 AND blocked_account_id = $2`, [customer.id, otherId])).length) },
      can_send: !why, why_not: why,
      has_more: rows.length === 40,
      messages: rows.reverse().map((m) => {
        const mine = Number(m.sender_account_id) === customer.id;
        return {
          id: Number(m.id), mine, type: m.type, deleted: Boolean(m.deleted_at), text: m.deleted_at ? '' : m.text, media_url: m.deleted_at ? null : link(m.media_key),
          created_at: m.created_at, status: mine ? (otherRead >= Number(m.id) ? 'read' : 'delivered') : undefined,
        };
      }),
    };
  }

  async send(customer: CustomerAccount, dmId: number, input: { text?: string; file?: Upload | null }) {
    const { d, otherId } = await this.dm(customer, dmId);
    const companyId = Number(d.company_id);
    if (!(await this.dmOn(companyId))) throw new ForbiddenException('This business turned off messages between members.');
    const why = await this.blockedReason(companyId, customer.id, otherId);
    if (why) throw new ForbiddenException(why);
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
      key = saveChatMedia(companyId, file.buffer, mime, file.originalname || 'file');
      if (mime.startsWith('image/')) type = 'image';
      else { type = 'file'; body = [file.originalname || 'file', text].filter(Boolean).join('\n'); }
    }
    if (!body && !key) throw new BadRequestException('Type a message.');
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_dm_message (dm_id, sender_account_id, type, text, media_key) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`, [dmId, customer.id, type, body, key]);
    const mineIsA = Number(d.account_a) === customer.id;
    await this.dataSource.query(`UPDATE ca_dm SET last_message_at = NOW(), ${mineIsA ? 'a_last_read_id' : 'b_last_read_id'} = $2 WHERE id = $1`, [dmId, row.id]);
    this.app.pingCustomer(otherId, companyId);
    this.app.pingCustomer(customer.id, companyId);
    const [me] = await this.dataSource.query(`SELECT id, name, show_name FROM ca_account WHERE id = $1`, [customer.id]);
    this.push.notify([otherId], companyId, {
      title: this.label(companyId, me).name, body: type === 'image' ? '📷 Photo' : type === 'file' ? '📎 File' : body, target: { kind: 'dm', id: dmId },
    });
    return { id: Number(row.id), created_at: row.created_at };
  }

  async deleteOwn(customer: CustomerAccount, dmId: number, messageId: number) {
    const { d, otherId } = await this.dm(customer, dmId);
    const result = await this.dataSource.query(`UPDATE ca_dm_message SET deleted_at = NOW() WHERE id = $1 AND dm_id = $2 AND sender_account_id = $3 AND deleted_at IS NULL RETURNING id`, [messageId, dmId, customer.id]);
    if (!returned(result).length) throw new NotFoundException('Message not found.');
    this.app.pingCustomer(otherId, Number(d.company_id));
    return { deleted: true };
  }

  /* ───────── block / report ───────── */

  async block(customer: CustomerAccount, member: string, blocked: boolean) {
    const other = memberId(member);
    if (other === customer.id) throw new BadRequestException('This is you.');
    if (blocked) await this.dataSource.query(`INSERT INTO ca_block (account_id, blocked_account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [customer.id, other]);
    else await this.dataSource.query(`DELETE FROM ca_block WHERE account_id = $1 AND blocked_account_id = $2`, [customer.id, other]);
    return { blocked };
  }

  /** A report goes to the business, with a copy of the message (it may be deleted later). */
  async report(customer: CustomerAccount, companyId: number, input: { member?: string; group_id?: number; group_message_id?: number; dm_message_id?: number; reason?: string }) {
    await this.app.place(customer, companyId);
    const reason = String(input.reason ?? '').trim().slice(0, 500);
    if (!reason) throw new BadRequestException('Tell the business what is wrong.');
    let target: number | null = input.member ? memberId(input.member) : null;
    let excerpt: string | null = null;
    let groupId: number | null = null;
    if (input.group_message_id) {
      const [m] = await this.dataSource.query(`
        SELECT m.text, m.sender_account_id, m.group_id FROM ca_group_message m JOIN ca_group g ON g.id = m.group_id AND g.company_id = $2
          JOIN ca_group_member gm ON gm.group_id = g.id AND gm.account_id = $3 WHERE m.id = $1`, [Number(input.group_message_id), companyId, customer.id]);
      if (!m) throw new NotFoundException('Message not found.');
      excerpt = String(m.text ?? '').slice(0, 500); target = m.sender_account_id ? Number(m.sender_account_id) : target; groupId = Number(m.group_id);
    } else if (input.dm_message_id) {
      const [m] = await this.dataSource.query(`
        SELECT m.text, m.sender_account_id FROM ca_dm_message m JOIN ca_dm d ON d.id = m.dm_id AND d.company_id = $2 AND (d.account_a = $3 OR d.account_b = $3)
         WHERE m.id = $1`, [Number(input.dm_message_id), companyId, customer.id]);
      if (!m) throw new NotFoundException('Message not found.');
      excerpt = String(m.text ?? '').slice(0, 500); target = Number(m.sender_account_id);
    } else if (input.group_id) {
      const [g] = await this.dataSource.query(`
        SELECT g.id FROM ca_group g JOIN ca_group_member gm ON gm.group_id = g.id AND gm.account_id = $3 WHERE g.id = $1 AND g.company_id = $2`, [Number(input.group_id), companyId, customer.id]);
      if (!g) throw new NotFoundException('Group not found.');
      groupId = Number(g.id);
    }
    if (target === customer.id) throw new BadRequestException('You can not report yourself.');
    // only people of this business's app (never a way to look up other customers)
    if (target) {
      const [known] = await this.dataSource.query(`
        SELECT 1 FROM ca_account a JOIN ca_app_member am ON am.company_id = $2 AND am.phone = a.phone WHERE a.id = $1`, [target, companyId]);
      if (!known) throw new NotFoundException('Member not found.');
    }
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_report (company_id, reporter_account_id, target_account_id, group_id, group_message_id, dm_message_id, reason, excerpt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, customer.id, target, groupId, input.group_message_id ?? null, input.dm_message_id ?? null, reason, excerpt]);
    return { id: Number(row.id), reported: true };
  }

  /* ───────── business: reports ───────── */

  async reports(companyId: number, open = true) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT r.*, COALESCE(rm.name, rp.name) AS reporter_name, rm.phone AS reporter_phone, COALESCE(tm.name, t.name) AS target_name, tm.phone AS target_phone, g.name AS group_name
        FROM ca_report r
        LEFT JOIN ca_account rp ON rp.id = r.reporter_account_id LEFT JOIN ca_app_member rm ON rm.company_id = r.company_id AND rm.phone = rp.phone
        LEFT JOIN ca_account t ON t.id = r.target_account_id LEFT JOIN ca_app_member tm ON tm.company_id = r.company_id AND tm.phone = t.phone
        LEFT JOIN ca_group g ON g.id = r.group_id AND g.company_id = r.company_id
       WHERE r.company_id = $1 AND (($2 AND r.resolved_at IS NULL) OR (NOT $2 AND r.resolved_at IS NOT NULL))
       ORDER BY r.created_at DESC LIMIT 200`, [companyId, open]);
    return rows.map((r) => ({
      id: Number(r.id), reason: r.reason, excerpt: r.excerpt, created_at: r.created_at, resolved_at: r.resolved_at, group: r.group_name ?? null,
      kind: r.dm_message_id ? 'member message' : r.group_message_id ? 'group message' : r.target_account_id ? 'member' : 'group',
      reporter: { name: r.reporter_name || 'Customer', phone: r.reporter_phone ? `+${r.reporter_phone}` : null },
      target: r.target_account_id ? { name: r.target_name || 'Customer', phone: r.target_phone ? `+${r.target_phone}` : null, code: this.app.memberCode(companyId, Number(r.target_account_id)) } : null,
    }));
  }

  async resolve(companyId: number, userId: number, id: number) {
    const result = await this.dataSource.query(`UPDATE ca_report SET resolved_at = NOW(), resolved_by = $3 WHERE id = $1 AND company_id = $2 AND resolved_at IS NULL RETURNING id`, [id, companyId, userId]);
    if (!returned(result).length) throw new NotFoundException('Report not found.');
    return { resolved: true };
  }
}
