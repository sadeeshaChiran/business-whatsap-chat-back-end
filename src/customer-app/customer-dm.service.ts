import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
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



  /** How the other member is shown to me. */
  private label(companyId: number, row: { id: number | string; name?: string | null; show_name?: boolean; avatar_key?: string | null } | null) {
    if (!row) return { name: 'Deleted user', avatar_url: null, code: null as string | null };
    const code = this.app.memberCode(companyId, Number(row.id));
    return { name: row.show_name && row.name ? String(row.name) : `Member #${code}`, avatar_url: row.show_name ? link(row.avatar_key, 24) : null, code };
  }

  /** The business's member-message settings: off, "groups" (members of a group that shows its member list) or "roles" (role pairs). */
  private async dmSettings(companyId: number) {
    const [row] = await this.dataSource.query(`SELECT member_dm, dm_mode, dm_rules FROM ca_settings WHERE company_id = $1`, [companyId]);
    const rules = (Array.isArray(row?.dm_rules) ? row.dm_rules : []).filter((pair: unknown) => Array.isArray(pair) && pair.length === 2).map((pair: unknown[]) => [String(pair[0]), String(pair[1])] as [string, string]);
    return { on: Boolean(row?.member_dm), mode: row?.dm_mode === 'roles' ? 'roles' as const : 'groups' as const, rules };
  }

  /** May someone with roles `a` message someone with roles `b`? A pair works both ways; "*" = anyone on the list. */
  static rolesAllowed(rules: Array<[string, string]>, a: string[], b: string[]) {
    const has = (roles: string[], role: string) => role === '*' || roles.includes(role);
    return rules.some(([x, y]) => (has(a, x) && has(b, y)) || (has(a, y) && has(b, x)));
  }

  /** Why I can't message this member (null = I can). */
  private async blockedReason(companyId: number, me: number, other: number): Promise<string | null> {
    if (me === other) return 'This is you.';
    const settings = await this.dmSettings(companyId);
    if (!settings.on) return 'This business turned off messages between members.';
    const [row] = await this.dataSource.query(`
      SELECT a.allow_dm, (am.phone IS NOT NULL) AS member, COALESCE(am.roles, '{}') AS roles,
             (SELECT COALESCE(mm.roles, '{}') FROM ca_account ma JOIN ca_app_member mm ON mm.company_id = $1 AND mm.phone = ma.phone WHERE ma.id = $2) AS my_roles,
             EXISTS (SELECT 1 FROM ca_block b WHERE b.account_id = $2 AND b.blocked_account_id = a.id) AS i_blocked,
             EXISTS (SELECT 1 FROM ca_block b WHERE b.account_id = a.id AND b.blocked_account_id = $2) AS they_blocked,
             EXISTS (SELECT 1 FROM ca_group_member x JOIN ca_group g ON g.id = x.group_id AND g.archived_at IS NULL AND g.company_id = $1
                       JOIN ca_group_member y ON y.group_id = x.group_id AND y.account_id = a.id WHERE x.account_id = $2) AS shared
        FROM ca_account a LEFT JOIN ca_app_member am ON am.company_id = $1 AND am.phone = a.phone WHERE a.id = $3`, [companyId, me, other]);
    if (!row || !row.member) return 'This member is no longer here.';
    if (row.i_blocked) return 'You blocked this member. Unblock them to send a message.';
    if (row.they_blocked || !row.allow_dm) return 'This member does not take messages.';
    if (settings.mode === 'roles') {
      if (!CustomerDmService.rolesAllowed(settings.rules, row.my_roles ?? [], row.roles ?? [])) return 'The business does not allow messages between you and this member.';
    } else if (!row.shared) return 'You can only message members of your groups.';
    return null;
  }

  /** For calls: why this member can't be called (null = ok) – the same rules as messages. */
  whyNot(companyId: number, me: number, other: number) {
    return this.blockedReason(companyId, me, other);
  }

  async deviceIds(me: number, other: number) {
    return new Set((await this.participantKeys(me, other)).map((d) => d.device_id));
  }

  /** A member call's media key, sealed on the caller's phone for the devices of both people (the server can't open it). */
  checkSealedKey(raw: unknown, allowed: Set<string>) {
    const value = (raw ?? {}) as Row;
    const ok = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && /^[\w-]+$/.test(v);
    if (value.v !== 1 || !ok(value.sender_pub, 120) || !ok(value.sender_device, 64) || typeof value.keys !== 'object' || !value.keys) {
      throw new BadRequestException('Calls between members are end-to-end encrypted – please update the app (reload the page).');
    }
    const keys: Record<string, { iv: string; wk: string }> = {};
    for (const [device, w] of Object.entries(value.keys as Record<string, Row>)) if (allowed.has(device) && ok(w?.iv, 32) && ok(w?.wk, 120)) keys[device] = { iv: w.iv, wk: w.wk };
    if (!Object.keys(keys).length) throw new BadRequestException('The other person has not opened the app on a phone yet.');
    return { v: 1, sender_pub: value.sender_pub, sender_device: value.sender_device, keys };
  }

  /** Online now / last seen – hidden when either person turned "last seen" off (like WhatsApp). */
  presence(viewerShows: boolean, row: { last_active_at?: Date | string | null; show_last_seen?: boolean } | null) {
    if (!row || !viewerShows || row.show_last_seen === false || !row.last_active_at) return { online: false, last_seen: null as string | null };
    const at = new Date(row.last_active_at);
    return { online: Date.now() - at.getTime() < 70_000, last_seen: at.toISOString() };
  }

  private async viewerShowsLastSeen(accountId: number) {
    const [row] = await this.dataSource.query(`SELECT show_last_seen FROM ca_account WHERE id = $1`, [accountId]);
    return row?.show_last_seen !== false;
  }

  /** "New message": the members I may message (names / member IDs and roles – never numbers). */
  async people(customer: CustomerAccount, companyId: number, search = '') {
    await this.app.place(customer, companyId);
    const settings = await this.dmSettings(companyId);
    if (!settings.on) return { enabled: false, items: [] };
    const q = `%${search.trim().toLowerCase()}%`;
    const rows: Row[] = await this.dataSource.query(`
      SELECT a.id, a.name, a.show_name, a.avatar_key, a.last_active_at, a.show_last_seen, COALESCE(am.roles, '{}') AS roles,
             EXISTS (SELECT 1 FROM ca_group_member x JOIN ca_group g ON g.id = x.group_id AND g.archived_at IS NULL AND g.company_id = $1
                       JOIN ca_group_member y ON y.group_id = x.group_id AND y.account_id = a.id WHERE x.account_id = $2) AS shared
        FROM ca_app_member am JOIN ca_account a ON a.phone = am.phone
       WHERE am.company_id = $1 AND am.joined_at IS NOT NULL AND a.id <> $2 AND a.allow_dm
         AND NOT EXISTS (SELECT 1 FROM ca_block b WHERE (b.account_id = $2 AND b.blocked_account_id = a.id) OR (b.account_id = a.id AND b.blocked_account_id = $2))
         AND ($3 = '%%' OR (a.show_name AND LOWER(COALESCE(a.name, '')) LIKE $3))
       ORDER BY a.last_active_at DESC NULLS LAST LIMIT 500`, [companyId, customer.id, q]);
    const [me] = await this.dataSource.query(`SELECT COALESCE(am.roles, '{}') AS roles FROM ca_app_member am WHERE am.company_id = $1 AND am.phone = $2`, [companyId, customer.phone]);
    const shows = await this.viewerShowsLastSeen(customer.id);
    const allowed = rows.filter((r) => (settings.mode === 'roles' ? CustomerDmService.rolesAllowed(settings.rules, me?.roles ?? [], r.roles ?? []) : r.shared));
    return {
      enabled: true,
      items: allowed.slice(0, 200).map((r) => ({
        member: `m${r.id}`, ...this.label(companyId, { id: r.id, name: r.name, show_name: r.show_name, avatar_key: r.avatar_key }), roles: r.roles ?? [],
        ...this.presence(shows, r),
      })),
    };
  }

  /** My member chats in this business's app. */
  async list(customer: CustomerAccount, companyId: number) {
    const place = await this.app.place(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT d.id, d.last_message_at, o.id AS other_id, o.name, o.show_name, o.avatar_key, o.last_active_at, o.show_last_seen,
             last.text AS last_text, last.type AS last_type, last.sender_account_id AS last_sender, last.deleted_at AS last_deleted, last.cipher AS last_cipher,
             (SELECT COUNT(*)::int FROM ca_dm_message m WHERE m.dm_id = d.id AND m.deleted_at IS NULL AND m.sender_account_id <> $2
                AND m.id > CASE WHEN d.account_a = $2 THEN d.a_last_read_id ELSE d.b_last_read_id END) AS unread
        FROM ca_dm d
        LEFT JOIN ca_account o ON o.id = CASE WHEN d.account_a = $2 THEN d.account_b ELSE d.account_a END
        LEFT JOIN LATERAL (SELECT text, type, sender_account_id, deleted_at, cipher FROM ca_dm_message m WHERE m.dm_id = d.id ORDER BY m.id DESC LIMIT 1) last ON TRUE
       WHERE d.company_id = $1 AND (d.account_a = $2 OR d.account_b = $2) AND d.last_message_at IS NOT NULL
       ORDER BY d.last_message_at DESC LIMIT 200`, [companyId, customer.id]);
    const shows = await this.viewerShowsLastSeen(customer.id);
    return {
      enabled: place.member_dm,
      items: rows.map((r) => ({
        id: Number(r.id), member: r.other_id ? `m${r.other_id}` : null, ...this.label(companyId, r.other_id ? { id: r.other_id, name: r.name, show_name: r.show_name, avatar_key: r.avatar_key } : null),
        ...this.presence(shows, r.other_id ? r : null),
        unread: Number(r.unread ?? 0), last_at: r.last_message_at,
        last: r.last_deleted ? 'Message deleted' : `${Number(r.last_sender) === customer.id ? 'You: ' : ''}${r.last_type === 'image' ? '📷 Photo' : r.last_type === 'file' ? '📎 File' : r.last_cipher ? '🔒 Message' : String(r.last_text ?? '').slice(0, 100)}`,
        last_cipher: !r.last_deleted && r.last_type === 'text' ? r.last_cipher ?? null : null, last_mine: Number(r.last_sender) === customer.id,
      })),
    };
  }

  /** Open (or start) a chat with a member of one of my groups. */
  async start(customer: CustomerAccount, companyId: number, member: string) {
    await this.app.place(customer, companyId);
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
    const [other] = await this.dataSource.query(`SELECT id, name, show_name, avatar_key, last_active_at, show_last_seen FROM ca_account WHERE id = $1`, [otherId]);
    const shows = await this.viewerShowsLastSeen(customer.id);
    const otherActive = other?.last_active_at ? new Date(other.last_active_at).getTime() : 0;
    const rows: Row[] = await this.dataSource.query(`
      SELECT * FROM ca_dm_message WHERE dm_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 40`, [dmId, beforeId ?? null]);
    const newest = rows[0]?.id ? Number(rows[0].id) : 0;
    const mineIsA = Number(d.account_a) === customer.id;
    if (!beforeId && newest > Number(mineIsA ? d.a_last_read_id : d.b_last_read_id)) {
      await this.dataSource.query(`UPDATE ca_dm SET ${mineIsA ? 'a_last_read_id' : 'b_last_read_id'} = GREATEST(${mineIsA ? 'a_last_read_id' : 'b_last_read_id'}, $2) WHERE id = $1`, [dmId, newest]);
    }
    const otherRead = Number(mineIsA ? d.b_last_read_id : d.a_last_read_id);
    const why = await this.blockedReason(companyId, customer.id, otherId);
    const [company] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    return {
      chat: { id: dmId, company_id: companyId, company_name: String(company?.name ?? ''), member: `m${otherId}`, ...this.label(companyId, other ?? null), ...this.presence(shows, other ?? null),
        blocked_by_me: Boolean((await this.dataSource.query(`SELECT 1 FROM ca_block WHERE account_id = $1 AND blocked_account_id = $2`, [customer.id, otherId])).length) },
      can_send: !why, why_not: why,
      has_more: rows.length === 40,
      messages: rows.reverse().map((m) => {
        const mine = Number(m.sender_account_id) === customer.id;
        return {
          id: Number(m.id), mine, type: m.type, deleted: Boolean(m.deleted_at), text: m.deleted_at ? '' : m.text, media_url: m.deleted_at ? null : link(m.media_key),
          cipher: m.deleted_at ? null : m.cipher ?? null,
          created_at: m.created_at, status: mine ? (otherRead >= Number(m.id) ? 'read' : otherActive >= new Date(m.created_at).getTime() ? 'delivered' : 'sent') : undefined,
        };
      }),
    };
  }

  /* ───────── end-to-end encryption: device keys ───────── */

  /** This phone / browser's public key (the private key stays on the device). */
  async registerKey(customer: CustomerAccount, input: { device_id?: unknown; public_key?: unknown }) {
    const deviceId = String(input.device_id ?? '');
    const publicKey = String(input.public_key ?? '');
    if (!/^[\w-]{16,64}$/.test(deviceId) || !/^[\w-]{80,120}$/.test(publicKey)) throw new BadRequestException('Not a device key.');
    const [count] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM ca_device_key WHERE account_id = $1 AND revoked_at IS NULL AND device_id <> $2`, [customer.id, deviceId]);
    if (Number(count?.n ?? 0) >= 8) {
      // more than 8 phones / browsers: the one unused the longest is logged out of encrypted chats
      await this.dataSource.query(`
        UPDATE ca_device_key SET revoked_at = NOW() WHERE (account_id, device_id) IN (
          SELECT account_id, device_id FROM ca_device_key WHERE account_id = $1 AND revoked_at IS NULL AND device_id <> $2 ORDER BY last_used_at LIMIT 1)`, [customer.id, deviceId]);
    }
    await this.dataSource.query(`
      INSERT INTO ca_device_key (account_id, device_id, public_key) VALUES ($1, $2, $3)
      ON CONFLICT (account_id, device_id) DO UPDATE SET last_used_at = NOW(),
        public_key = CASE WHEN ca_device_key.revoked_at IS NULL THEN ca_device_key.public_key ELSE EXCLUDED.public_key END, revoked_at = NULL`,
    [customer.id, deviceId, publicKey]);
    const [row] = await this.dataSource.query(`SELECT public_key FROM ca_device_key WHERE account_id = $1 AND device_id = $2`, [customer.id, deviceId]);
    // a device id can never be taken over with another key
    if (row?.public_key !== publicKey) throw new BadRequestException('This device id belongs to another key – make a new one.');
    return { registered: true };
  }

  async revokeKey(customer: CustomerAccount, deviceId: string) {
    await this.dataSource.query(`UPDATE ca_device_key SET revoked_at = NOW() WHERE account_id = $1 AND device_id = $2`, [customer.id, deviceId]);
    return { revoked: true };
  }

  async revokeAllKeys(accountId: number) {
    await this.dataSource.query(`UPDATE ca_device_key SET revoked_at = NOW() WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]);
  }

  private async participantKeys(meId: number, otherId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT account_id, device_id, public_key FROM ca_device_key WHERE account_id = ANY($1::bigint[]) AND revoked_at IS NULL ORDER BY account_id, created_at`, [[meId, otherId]]);
    return rows.map((r) => ({ owner: Number(r.account_id) === meId ? 'me' : 'them', device_id: String(r.device_id), public_key: String(r.public_key) }));
  }

  /** The devices a message must be encrypted for: mine and theirs. */
  async keys(customer: CustomerAccount, dmId: number) {
    const { otherId } = await this.dm(customer, dmId);
    const devices = await this.participantKeys(customer.id, otherId);
    return { devices, security_code: this.securityCode(devices) };
  }

  /** "Security code": the same 60 digits on both phones while nobody added a new device (compare them to be sure). */
  private securityCode(devices: Array<{ public_key: string }>) {
    const digest = createHash('sha512').update(devices.map((d) => d.public_key).sort().join('|')).digest();
    return Array.from({ length: 12 }, (_, i) => String(digest.readUInt32BE(i * 4) % 100000).padStart(5, '0')).join(' ');
  }

  /** Only the shape is checked – the server can not (and does not try to) read it. */
  private cipherOf(raw: unknown, allowed: Set<string>): Row {
    let value: Row;
    try {
      value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Row;
    } catch {
      throw new BadRequestException('Not an encrypted message.');
    }
    const b64 = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && /^[\w-]+$/.test(v);
    if (!value || value.v !== 1 || !b64(value.iv, 32) || !b64(value.ct, 40000) || !b64(value.sender_pub, 120) || !b64(value.sender_device, 64)
      || typeof value.keys !== 'object' || !value.keys || Array.isArray(value.keys)) throw new BadRequestException('Not an encrypted message.');
    const keys: Record<string, { iv: string; wk: string }> = {};
    for (const [device, wrap] of Object.entries(value.keys as Record<string, Row>)) {
      if (allowed.has(device) && b64(wrap?.iv, 32) && b64(wrap?.wk, 120)) keys[device] = { iv: String(wrap.iv), wk: String(wrap.wk) };
    }
    if (!Object.keys(keys).length) throw new BadRequestException('The message is not encrypted for any device of this chat.');
    const media = value.media && b64(value.media.iv, 32) ? { iv: String(value.media.iv) } : undefined;
    return { v: 1, iv: value.iv, ct: value.ct, sender_pub: value.sender_pub, sender_device: value.sender_device, keys, ...(media ? { media } : {}) };
  }

  /** Send an end-to-end encrypted message (text, or a photo / file encrypted on the phone). */
  async send(customer: CustomerAccount, dmId: number, input: { cipher?: unknown; kind?: string; file?: Upload | null; text?: string }) {
    const { d, otherId } = await this.dm(customer, dmId);
    const companyId = Number(d.company_id);
    const why = await this.blockedReason(companyId, customer.id, otherId);
    if (why) throw new ForbiddenException(why);
    if (input.cipher === undefined || input.cipher === null || input.cipher === '') {
      throw new BadRequestException('Member chats are end-to-end encrypted – please update the app (reload the page) and send again.');
    }
    const devices = await this.participantKeys(customer.id, otherId);
    const cipher = this.cipherOf(input.cipher, new Set(devices.map((x) => x.device_id)));
    let type = 'text';
    let key: string | null = null;
    const file = input.file?.buffer?.length ? input.file : null;
    if (file) {
      if (file.buffer.length > MAX_FILE_MB * 1024 * 1024 + 64) throw new BadRequestException(`Files can be up to ${MAX_FILE_MB} MB.`);
      if (!cipher.media) throw new BadRequestException('Not an encrypted file.');
      // stored as unreadable bytes – only the two phones can open it
      key = saveChatMedia(companyId, file.buffer, 'application/octet-stream', 'encrypted.bin');
      type = input.kind === 'image' ? 'image' : 'file';
    }
    const [row] = await this.dataSource.query(`
      INSERT INTO ca_dm_message (dm_id, sender_account_id, type, text, media_key, cipher) VALUES ($1, $2, $3, '', $4, $5::jsonb) RETURNING id, created_at`,
    [dmId, customer.id, type, key, JSON.stringify(cipher)]);
    const mineIsA = Number(d.account_a) === customer.id;
    await this.dataSource.query(`UPDATE ca_dm SET last_message_at = NOW(), ${mineIsA ? 'a_last_read_id' : 'b_last_read_id'} = $2 WHERE id = $1`, [dmId, row.id]);
    await this.dataSource.query(`UPDATE ca_device_key SET last_used_at = NOW() WHERE account_id = $1 AND device_id = $2`, [customer.id, cipher.sender_device]);
    this.app.pingCustomer(otherId, companyId);
    this.app.pingCustomer(customer.id, companyId);
    const [me] = await this.dataSource.query(`SELECT id, name, show_name FROM ca_account WHERE id = $1`, [customer.id]);
    // the server can't read it, so the notification can't either
    this.push.notify([otherId], companyId, { title: this.label(companyId, me).name, body: type === 'image' ? '🔒 Photo' : type === 'file' ? '🔒 File' : '🔒 New message', target: { kind: 'dm', id: dmId } });
    return { id: Number(row.id), created_at: row.created_at };
  }

  /**
   * A new phone of either person: a device that can read a message wraps its key for the new device too. Only adds wraps for
   * the chat's current devices; nothing that is already there can be changed.
   */
  async addWraps(customer: CustomerAccount, dmId: number, input: { messages?: unknown }) {
    const { otherId } = await this.dm(customer, dmId);
    const allowed = new Set((await this.participantKeys(customer.id, otherId)).map((x) => x.device_id));
    const list = (Array.isArray(input.messages) ? input.messages : []).slice(0, 200) as Row[];
    let added = 0;
    for (const item of list) {
      const id = Number(item?.id);
      const wraps = Object.entries((item?.keys ?? {}) as Record<string, Row>)
        .filter(([device, w]) => allowed.has(device) && typeof w?.iv === 'string' && typeof w?.wk === 'string' && /^[\w-]{1,32}$/.test(w.iv) && /^[\w-]{1,120}$/.test(w.wk)
          && typeof w?.from === 'string' && /^[\w-]{80,120}$/.test(w.from))
        // "from" = the public key of the device that wrapped it (the receiving device needs it to unwrap)
        .map(([device, w]) => [device, { iv: w.iv, wk: w.wk, from: w.from }] as const);
      if (!Number.isInteger(id) || !wraps.length) continue;
      const result = await this.dataSource.query(`
        UPDATE ca_dm_message SET cipher = jsonb_set(cipher, '{keys}', $3::jsonb || (cipher -> 'keys'))
         WHERE id = $1 AND dm_id = $2 AND cipher IS NOT NULL AND deleted_at IS NULL RETURNING id`, [id, dmId, JSON.stringify(Object.fromEntries(wraps))]);
      added += returned(result).length;
    }
    return { updated: added };
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
  async report(customer: CustomerAccount, companyId: number, input: { member?: string; group_id?: number; group_message_id?: number; dm_message_id?: number; reason?: string; excerpt?: string }) {
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
        SELECT m.text, m.cipher, m.sender_account_id FROM ca_dm_message m JOIN ca_dm d ON d.id = m.dm_id AND d.company_id = $2 AND (d.account_a = $3 OR d.account_b = $3)
         WHERE m.id = $1`, [Number(input.dm_message_id), companyId, customer.id]);
      if (!m) throw new NotFoundException('Message not found.');
      // encrypted: only the reporter's phone can read it, so the text comes from the report (shown as "as reported")
      excerpt = m.cipher ? (String(input.excerpt ?? '').trim().slice(0, 500) ? `(as reported) ${String(input.excerpt).trim().slice(0, 480)}` : null) : String(m.text ?? '').slice(0, 500);
      target = Number(m.sender_account_id);
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
