import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { DataSource } from 'typeorm';
import { PusherService } from '../common/pusher.service';
import { CustomerAppService } from './customer-app.service';
import type { CustomerAccount } from './customer-auth';
import { CustomerDmService } from './customer-dm.service';
import { CustomerPushService } from './customer-push.service';

type Row = Record<string, any>;
export type MeetingAudience = { all?: boolean; group_ids?: number[]; roles?: string[]; account_ids?: number[] };

const RING_SECONDS = 45;
/** A call nobody hung up (closed tab, lost phone) is closed after this. */
const MAX_CALL_HOURS = 4;
const returned = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : Array.isArray(result) ? result : []) as Row[];

/**
 * Voice / video calls and meetings in the customer app, on LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).
 * Calls: customer ↔ the business team, member ↔ member (only when they may message each other). Member calls carry an
 * end-to-end media key that only the two phones can open. Meetings: the team (and people with a host role) schedule them,
 * invite everyone / groups / roles / people; only invited people get a token to join.
 */
@Injectable()
export class CustomerCallsService {
  private readonly pusher = new PusherService();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly app: CustomerAppService,
    private readonly dms: CustomerDmService,
    private readonly push: CustomerPushService,
  ) {}

  /* ───────────────────────── LiveKit ───────────────────────── */

  private livekit() {
    const url = String(process.env.LIVEKIT_URL ?? '').trim();
    const key = String(process.env.LIVEKIT_API_KEY ?? '').trim();
    const secret = String(process.env.LIVEKIT_API_SECRET ?? '').trim();
    return url && key && secret ? { url, key, secret } : null;
  }

  /** Close a LiveKit room: everyone still in it is disconnected (used when a call ends or a meeting is cancelled). */
  private closeRoom(room: string) {
    const lk = this.livekit();
    if (!lk || !room) return;
    const host = lk.url.replace(/^ws(s?):\/\//, 'http$1://');
    void new RoomServiceClient(host, lk.key, lk.secret).deleteRoom(room).catch(() => undefined);
  }

  config() {
    const lk = this.livekit();
    return { enabled: Boolean(lk), url: lk?.url ?? null };
  }

  private async token(room: string, identity: string, name: string, opts: { admin?: boolean; minutes?: number } = {}) {
    const lk = this.livekit();
    if (!lk) throw new ServiceUnavailableException('Calls are not set up on this server yet (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).');
    const minutes = Math.max(5, Math.min(MAX_CALL_HOURS * 60, Math.round(opts.minutes ?? MAX_CALL_HOURS * 60)));
    const at = new AccessToken(lk.key, lk.secret, { identity, name, ttl: `${minutes}m` });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: Boolean(opts.admin) });
    return { url: lk.url, token: await at.toJwt(), room };
  }

  private async customerName(companyId: number, accountId: number) {
    const [a] = await this.dataSource.query(`SELECT name, show_name FROM ca_account WHERE id = $1`, [accountId]);
    return a?.show_name && a?.name ? String(a.name) : `Member #${this.app.memberCode(companyId, accountId)}`;
  }

  private async staffName(userId: number) {
    const [u] = await this.dataSource.query(`SELECT name FROM app_user WHERE id = $1`, [userId]);
    return String(u?.name ?? 'Team');
  }

  /* ───────────────────────── calls ───────────────────────── */

  private view(c: Row, viewer: { accountId?: number }) {
    const expired = c.status === 'ringing' && Date.now() - new Date(c.created_at).getTime() > RING_SECONDS * 1000;
    return {
      id: Number(c.id), scope: c.scope, dm_id: c.dm_id ? Number(c.dm_id) : null, video: Boolean(c.video), status: expired ? 'missed' : c.status,
      outgoing: viewer.accountId ? Number(c.caller_account_id) === viewer.accountId : Boolean(c.caller_user_id),
      created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, e2ee: c.e2ee ?? null,
    };
  }

  /** A customer calls the business (any team member can answer from the dashboard). */
  async callBusiness(customer: CustomerAccount, companyId: number, video: boolean) {
    await this.app.place(customer, companyId);
    const room = `ca-${companyId}-call-${randomBytes(8).toString('hex')}`;
    const [c] = await this.dataSource.query(`
      INSERT INTO ca_call (company_id, scope, account_id, caller_account_id, video, room) VALUES ($1, 'business', $2, $2, $3, $4) RETURNING *`,
    [companyId, customer.id, video, room]);
    const name = await this.customerName(companyId, customer.id);
    this.pusher.trigger(`company-${companyId}`, 'app_call', { call_id: Number(c.id), name, video });
    return { call: this.view(c, { accountId: customer.id }), ...(await this.token(room, `ca-${customer.id}`, name)) };
  }

  /** A member calls another member – only when they may message each other. The media key is sealed for the two phones. */
  async callMember(customer: CustomerAccount, dmId: number, video: boolean, e2ee: unknown) {
    const [d] = await this.dataSource.query(`SELECT * FROM ca_dm WHERE id = $1 AND (account_a = $2 OR account_b = $2)`, [dmId, customer.id]);
    if (!d) throw new NotFoundException('This chat was not found.');
    const companyId = Number(d.company_id);
    await this.app.place(customer, companyId);
    const other = Number(d.account_a) === customer.id ? Number(d.account_b) : Number(d.account_a);
    const why = await this.dms.whyNot(companyId, customer.id, other);
    if (why) throw new ForbiddenException(why);
    const sealed = this.dms.checkSealedKey(e2ee, await this.dms.deviceIds(customer.id, other));
    const room = `ca-${companyId}-dm-${randomBytes(8).toString('hex')}`;
    const [c] = await this.dataSource.query(`
      INSERT INTO ca_call (company_id, scope, dm_id, caller_account_id, callee_account_id, video, room) VALUES ($1, 'dm', $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, dmId, customer.id, other, video, room]);
    await this.dataSource.query(`UPDATE ca_call SET e2ee = $2::jsonb WHERE id = $1`, [c.id, JSON.stringify(sealed)]);
    const name = await this.customerName(companyId, customer.id);
    this.app.pingCustomer(other, companyId);
    this.push.notify([other], companyId, { title: name, body: video ? '📹 Incoming video call' : '📞 Incoming call', target: { kind: 'dm', id: dmId }, tag: `call-${c.id}` });
    return { call: { ...this.view(c, { accountId: customer.id }), e2ee: sealed }, ...(await this.token(room, `ca-${customer.id}`, name)) };
  }

  /** Calls ringing for me (a member, or the business calling me). */
  async incoming(customer: CustomerAccount) {
    await this.sweep(`(caller_account_id = $1 OR callee_account_id = $1 OR account_id = $1)`, [customer.id]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.*, COALESCE(NULLIF(s.app_name, ''), co.company_name) AS company_name FROM ca_call c
        JOIN companies co ON co.id = c.company_id LEFT JOIN ca_settings s ON s.company_id = c.company_id
       WHERE c.status = 'ringing' AND c.created_at > NOW() - ($2 || ' seconds')::interval
         AND ((c.scope = 'dm' AND c.callee_account_id = $1) OR (c.scope = 'business' AND c.account_id = $1 AND c.caller_user_id IS NOT NULL))
       ORDER BY c.id DESC LIMIT 3`, [customer.id, String(RING_SECONDS)]);
    const out: Row[] = [];
    for (const c of rows) {
      const from = c.scope === 'dm' ? await this.customerName(Number(c.company_id), Number(c.caller_account_id)) : String(c.company_name);
      out.push({ ...this.view(c, { accountId: customer.id }), from, company_id: Number(c.company_id) });
    }
    return out;
  }

  private async ownCall(customer: CustomerAccount, callId: number) {
    const [c] = await this.dataSource.query(`
      SELECT * FROM ca_call WHERE id = $1 AND (caller_account_id = $2 OR callee_account_id = $2 OR (scope = 'business' AND account_id = $2))`, [callId, customer.id]);
    if (!c) throw new NotFoundException('Call not found.');
    return c as Row;
  }

  async answer(customer: CustomerAccount, callId: number) {
    const c = await this.ownCall(customer, callId);
    if (Number(c.caller_account_id) === customer.id) throw new BadRequestException('You started this call.');
    if (this.view(c, {}).status !== 'ringing') throw new BadRequestException('This call has ended.');
    const taken = await this.dataSource.query(`
      UPDATE ca_call SET status = 'active', answered_at = NOW() WHERE id = $1 AND status = 'ringing' AND created_at > NOW() - ($2 || ' seconds')::interval RETURNING id`,
    [callId, String(RING_SECONDS)]);
    if (!returned(taken).length) throw new BadRequestException('This call has ended.');
    const name = await this.customerName(Number(c.company_id), customer.id);
    this.pusher.trigger(`company-${c.company_id}`, 'app_call', { call_id: callId, status: 'active' });
    if (c.caller_account_id) this.app.pingCustomer(Number(c.caller_account_id), Number(c.company_id));
    return { call: { ...this.view({ ...c, status: 'active' }, { accountId: customer.id }), e2ee: c.e2ee ?? null }, ...(await this.token(String(c.room), `ca-${customer.id}`, name)) };
  }

  async end(customer: CustomerAccount, callId: number) {
    const c = await this.ownCall(customer, callId);
    return this.finish(c);
  }

  /** Hang up / decline / cancel: ringing → missed (or declined), active → ended. A line goes into the business chat. */
  private async finish(c: Row) {
    // decided in the UPDATE itself: if the other side answered a moment ago, this is "ended", not "missed"
    const result = await this.dataSource.query(`
      UPDATE ca_call SET status = CASE WHEN status = 'active' THEN 'ended' ELSE 'missed' END, ended_at = NOW()
       WHERE id = $1 AND status IN ('ringing', 'active') RETURNING *`, [c.id]);
    const done = returned(result)[0];
    if (!done) return { status: String(c.status) };
    const status = String(done.status);
    this.closeRoom(String(done.room));
    if (c.scope === 'business' && c.account_id) {
      const seconds = done.answered_at ? Math.round((new Date(done.ended_at).getTime() - new Date(done.answered_at).getTime()) / 1000) : 0;
      const text = `${done.video ? '📹 Video call' : '📞 Voice call'}${done.answered_at ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ' · missed'}`;
      await this.logInChat(Number(c.company_id), Number(c.account_id), done.caller_user_id ? 'outbound' : 'inbound', text).catch(() => undefined);
    }
    this.pusher.trigger(`company-${c.company_id}`, 'app_call', { call_id: Number(c.id), status });
    for (const id of [c.caller_account_id, c.callee_account_id, c.account_id]) if (id) this.app.pingCustomer(Number(id), Number(c.company_id));
    return { status };
  }

  private async logInChat(companyId: number, accountId: number, direction: 'inbound' | 'outbound', text: string) {
    const [a] = await this.dataSource.query(`SELECT id, phone, name, token_version FROM ca_account WHERE id = $1`, [accountId]);
    if (!a) return;
    const user = await this.app.channelUser({ id: Number(a.id), phone: a.phone, name: a.name, token_version: Number(a.token_version) }, companyId, true, { welcome: false });
    if (!user) return;
    const conversation = await this.app.conversation(Number(user.id));
    await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, source, created_at, updated_at)
      VALUES ($1, $2, 'text', 'app', $3, $4, $5, 'app-call', NOW(), NOW())`,
    [conversation.id, direction, `app:call${Date.now().toString(36)}`, direction === 'outbound' ? 'sent' : null, text]);
    await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`, [conversation.id]);
    this.app.notifyInbox(companyId, Number(conversation.id), direction, text);
  }

  /** Close calls nobody closed: unanswered after the ring time → missed (logged in the chat), left open for hours → ended. */
  private async sweep(where: string, params: unknown[]) {
    const stale: Row[] = await this.dataSource.query(`
      SELECT * FROM ca_call WHERE ${where} AND ((status = 'ringing' AND created_at < NOW() - INTERVAL '${RING_SECONDS} seconds')
         OR (status = 'active' AND answered_at < NOW() - INTERVAL '${MAX_CALL_HOURS} hours')) LIMIT 20`, params);
    for (const c of stale) await this.finish(c).catch(() => undefined);
  }

  /* ── business side ── */

  async ringing(companyId: number) {
    await this.sweep(`company_id = $1`, [companyId]);
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.*, cu.id AS channel_user_id FROM ca_call c
        LEFT JOIN bot_channel_user cu ON cu.company_id = c.company_id AND cu.platform = 'app' AND cu.external_user_id = 'ca:' || c.account_id
       WHERE c.company_id = $1 AND c.scope = 'business' AND c.status = 'ringing' AND c.caller_account_id IS NOT NULL
         AND c.created_at > NOW() - ($2 || ' seconds')::interval ORDER BY c.id DESC LIMIT 5`, [companyId, String(RING_SECONDS)]);
    const out: Row[] = [];
    for (const c of rows) {
      const [a] = await this.dataSource.query(`
        SELECT COALESCE(am.name, a.name, 'Customer') AS name FROM ca_account a LEFT JOIN ca_app_member am ON am.company_id = $2 AND am.phone = a.phone WHERE a.id = $1`, [c.account_id, companyId]);
      const [conv] = c.channel_user_id ? await this.dataSource.query(`SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [c.channel_user_id]) : [];
      out.push({ ...this.view(c, {}), from: String(a?.name ?? 'Customer'), conversation_id: conv ? Number(conv.id) : null });
    }
    return out;
  }

  /** The team calls a customer of the app (from the Inbox). */
  async staffCall(companyId: number, userId: number, input: { account_id?: number; conversation_id?: number; video?: boolean }) {
    let accountId = Number(input.account_id) || 0;
    if (!accountId && input.conversation_id) {
      const [row] = await this.dataSource.query(`
        SELECT cu.external_user_id FROM bot_conversation bc JOIN bot_channel_user cu ON cu.id = bc.bot_channel_user_id
         WHERE bc.id = $1 AND cu.company_id = $2 AND cu.platform = 'app'`, [Number(input.conversation_id), companyId]);
      accountId = Number(/^ca:(\d+)$/.exec(String(row?.external_user_id ?? ''))?.[1] ?? 0);
    }
    const [a] = accountId ? await this.dataSource.query(`
      SELECT a.id FROM ca_account a JOIN ca_app_member am ON am.company_id = $2 AND am.phone = a.phone WHERE a.id = $1`, [accountId, companyId]) : [];
    if (!a) throw new NotFoundException('This customer does not use your app.');
    const room = `ca-${companyId}-call-${randomBytes(8).toString('hex')}`;
    const [c] = await this.dataSource.query(`
      INSERT INTO ca_call (company_id, scope, account_id, caller_user_id, callee_account_id, video, room) VALUES ($1, 'business', $2, $3, $2, $4, $5) RETURNING *`,
    [companyId, accountId, userId, Boolean(input.video), room]);
    const [co] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    this.app.pingCustomer(accountId, companyId);
    this.push.notify([accountId], companyId, { title: String(co?.name ?? 'Business'), body: input.video ? '📹 Incoming video call' : '📞 Incoming call', target: { kind: 'chat' }, tag: `call-${c.id}` });
    return { call: this.view(c, {}), ...(await this.token(room, `staff-${userId}`, `${await this.staffName(userId)} · ${co?.name ?? ''}`)) };
  }

  async staffAnswer(companyId: number, userId: number, callId: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1 AND company_id = $2 AND scope = 'business'`, [callId, companyId]);
    if (!c) throw new NotFoundException('Call not found.');
    if (c.caller_user_id) {
      // the team's own call → only the person who placed it can rejoin it, while it is still on
      if (Number(c.caller_user_id) !== userId || !['ringing', 'active'].includes(this.view(c, {}).status)) throw new BadRequestException('This call has ended.');
      return { call: this.view(c, {}), ...(await this.token(String(c.room), `staff-${userId}`, await this.staffName(userId))) };
    }
    const taken = await this.dataSource.query(`
      UPDATE ca_call SET status = 'active', answered_at = NOW(), answered_by_user_id = $2 WHERE id = $1 AND status = 'ringing' AND created_at > NOW() - ($3 || ' seconds')::interval RETURNING id`,
    [callId, userId, String(RING_SECONDS)]);
    if (!returned(taken).length && !(c.status === 'active' && Number(c.answered_by_user_id) === userId)) throw new BadRequestException('Someone else answered, or the call ended.');
    this.pusher.trigger(`company-${companyId}`, 'app_call', { call_id: callId, status: 'active' });
    this.app.pingCustomer(Number(c.account_id), companyId);
    return { call: this.view({ ...c, status: 'active' }, {}), ...(await this.token(String(c.room), `staff-${userId}`, await this.staffName(userId))) };
  }

  async staffEnd(companyId: number, callId: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1 AND company_id = $2 AND scope = 'business'`, [callId, companyId]);
    if (!c) throw new NotFoundException('Call not found.');
    return this.finish(c);
  }

  async callStatus(companyId: number, callId: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1 AND company_id = $2 AND scope = 'business'`, [callId, companyId]);
    if (!c) throw new NotFoundException('Call not found.');
    return this.view(await this.settled(c), {});
  }

  async customerCallStatus(customer: CustomerAccount, callId: number) {
    return this.view(await this.settled(await this.ownCall(customer, callId)), { accountId: customer.id });
  }

  /** A ringing call past its ring time is closed (and logged as missed) the first time someone looks at it. */
  private async settled(c: Row) {
    if (c.status === 'ringing' && this.view(c, {}).status === 'missed') {
      await this.finish(c);
      const [fresh] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1`, [c.id]);
      return (fresh ?? c) as Row;
    }
    return c;
  }

  /* ───────────────────────── meetings ───────────────────────── */

  private cleanAudience(input: unknown): MeetingAudience {
    const a = (input ?? {}) as Row;
    const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000);
    const roles = (Array.isArray(a.roles) ? a.roles : []).map((r: unknown) => String(r).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    return { all: a.all === true, group_ids: ids(a.group_ids), roles, account_ids: ids(a.account_ids) };
  }

  /** Is this person invited? (everyone / their groups / their roles / by name) – checked when they join, so new group members can join too. */
  private async invited(m: Row, customer: CustomerAccount) {
    if (Number(m.host_account_id) === customer.id) return true;
    const a = m.audience as MeetingAudience;
    const [row] = await this.dataSource.query(`
      SELECT $3::boolean AS all_people,
             EXISTS (SELECT 1 FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.company_id = $1 AND g.archived_at IS NULL
                      WHERE gm.account_id = $2 AND gm.group_id = ANY($4::bigint[])) AS by_group,
             EXISTS (SELECT 1 FROM ca_app_member am WHERE am.company_id = $1 AND am.phone = $6 AND am.roles && $5::text[]) AS by_role`,
    [m.company_id, customer.id, Boolean(a.all), a.group_ids ?? [], a.roles ?? [], customer.phone]);
    return Boolean(row?.all_people || row?.by_group || row?.by_role || (a.account_ids ?? []).includes(customer.id));
  }

  private meetingView(m: Row, extra: Row = {}, forCustomer = false) {
    const start = new Date(m.starts_at).getTime();
    const end = start + Number(m.minutes) * 60_000;
    const now = Date.now();
    return {
      id: Number(m.id), code: m.code, title: m.title, starts_at: m.starts_at, minutes: Number(m.minutes), ...(forCustomer ? {} : { audience: m.audience }),
      state: m.cancelled_at ? 'cancelled' : now > end + 60 * 60_000 ? 'over' : now >= start - 15 * 60_000 ? 'open' : 'upcoming', ...extra,
    };
  }

  private async createMeeting(companyId: number, host: { userId?: number; accountId?: number }, input: Row) {
    const title = String(input.title ?? '').trim().slice(0, 120);
    if (!title) throw new BadRequestException('Give the meeting a name.');
    const starts = input.starts_at ? new Date(String(input.starts_at)) : new Date();
    if (Number.isNaN(starts.getTime())) throw new BadRequestException('Pick a date and time.');
    const minutes = Math.min(8 * 60, Math.max(10, Number(input.minutes) || 60));
    const audience = this.cleanAudience(input.audience);
    const code = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);
    const [m] = await this.dataSource.query(`
      INSERT INTO ca_meeting (company_id, title, starts_at, minutes, room, code, host_user_id, host_account_id, audience)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
    [companyId, title, starts.toISOString(), minutes, `ca-${companyId}-meet-${code}`, code, host.userId ?? null, host.accountId ?? null, JSON.stringify(audience)]);
    await this.announce(m);
    return this.meetingView(m, {}, Boolean(host.accountId));
  }

  /** Invited people get a phone notification. */
  private async announce(m: Row) {
    const a = m.audience as MeetingAudience;
    const rows: Row[] = await this.dataSource.query(`
      SELECT DISTINCT a.id FROM ca_app_member am JOIN ca_account a ON a.phone = am.phone
       WHERE am.company_id = $1 AND am.joined_at IS NOT NULL AND ($2 OR am.roles && $3::text[] OR a.id = ANY($4::bigint[])
          OR a.id IN (SELECT gm.account_id FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.company_id = $1 AND g.archived_at IS NULL
                       WHERE gm.group_id = ANY($5::bigint[])))`,
    [m.company_id, Boolean(a.all), a.roles ?? [], a.account_ids ?? [], a.group_ids ?? []]);
    const when = new Date(m.starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    this.push.notify(rows.map((r) => Number(r.id)).filter((id) => id !== Number(m.host_account_id)), Number(m.company_id), {
      title: `🎥 ${m.title}`, body: `Meeting · ${when}`, target: { kind: 'chat' }, tag: `meeting-${m.id}`,
    });
  }

  async businessMeetings(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.*, u.name AS host_user, a.name AS host_customer FROM ca_meeting m LEFT JOIN app_user u ON u.id = m.host_user_id LEFT JOIN ca_account a ON a.id = m.host_account_id
       WHERE m.company_id = $1 AND m.starts_at > NOW() - INTERVAL '30 days' ORDER BY m.starts_at DESC LIMIT 100`, [companyId]);
    const [s] = await this.dataSource.query(`SELECT slug, meeting_host_roles FROM ca_settings WHERE company_id = $1`, [companyId]);
    return {
      host_roles: s?.meeting_host_roles ?? [], slug: s?.slug ?? null, livekit: this.config().enabled,
      items: rows.map((m) => this.meetingView(m, { host: m.host_user ?? m.host_customer ?? 'Member' })),
    };
  }

  businessCreateMeeting(companyId: number, userId: number, input: Row) {
    return this.createMeeting(companyId, { userId }, input);
  }

  async cancelMeeting(companyId: number, meetingId: number) {
    const r = await this.dataSource.query(`UPDATE ca_meeting SET cancelled_at = NOW() WHERE id = $1 AND company_id = $2 AND cancelled_at IS NULL RETURNING id, room`, [meetingId, companyId]);
    if (!returned(r).length) throw new NotFoundException('Meeting not found.');
    this.closeRoom(String(returned(r)[0].room));
    return { cancelled: true };
  }

  async setHostRoles(companyId: number, roles: unknown) {
    const clean = (Array.isArray(roles) ? roles : []).map((r) => String(r).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    await this.dataSource.query(`UPDATE ca_settings SET meeting_host_roles = $2 WHERE company_id = $1`, [companyId, clean]);
    return { host_roles: clean };
  }

  async staffJoin(companyId: number, userId: number, meetingId: number) {
    const [m] = await this.dataSource.query(`SELECT * FROM ca_meeting WHERE id = $1 AND company_id = $2`, [meetingId, companyId]);
    if (!m || m.cancelled_at) throw new NotFoundException('Meeting not found.');
    if (this.meetingView(m).state === 'over') throw new BadRequestException('This meeting is over.');
    return { meeting: this.meetingView(m), ...(await this.token(String(m.room), `staff-${userId}`, await this.staffName(userId), { admin: true, minutes: this.minutesLeft(m) })) };
  }

  /** Share the meeting link into groups (posted as the business). */
  async shareToGroups(companyId: number, userId: number, meetingId: number, groupIds: unknown, post: (groupId: number, text: string) => Promise<unknown>) {
    const [m] = await this.dataSource.query(`SELECT m.*, s.slug FROM ca_meeting m JOIN ca_settings s ON s.company_id = m.company_id WHERE m.id = $1 AND m.company_id = $2`, [meetingId, companyId]);
    if (!m) throw new NotFoundException('Meeting not found.');
    const ids = (Array.isArray(groupIds) ? groupIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const groups: Row[] = await this.dataSource.query(`SELECT id FROM ca_group WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NULL`, [companyId, ids]);
    const base = String(process.env.APP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
    const when = new Date(m.starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Colombo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const text = `🎥 ${m.title}\n${when} · ${m.minutes} min\nJoin: ${base}/app/${m.slug}/meet/${m.code}`;
    for (const g of groups) await post(Number(g.id), text);
    // people in these groups may join from now on
    const audience = m.audience as MeetingAudience;
    const merged = { ...audience, group_ids: [...new Set([...(audience.group_ids ?? []), ...groups.map((g) => Number(g.id))])] };
    await this.dataSource.query(`UPDATE ca_meeting SET audience = $2::jsonb WHERE id = $1`, [meetingId, JSON.stringify(merged)]);
    return { shared: groups.length };
  }

  /** A meeting token lasts until an hour after the planned end. */
  private minutesLeft(m: Row) {
    return (new Date(m.starts_at).getTime() + (Number(m.minutes) + 60) * 60_000 - Date.now()) / 60_000;
  }

  /* ── customer side ── */

  private async canHost(customer: CustomerAccount, companyId: number) {
    const [row] = await this.dataSource.query(`
      SELECT (s.meeting_host_roles && COALESCE(am.roles, '{}')) AS host FROM ca_settings s
        LEFT JOIN ca_app_member am ON am.company_id = s.company_id AND am.phone = $2 WHERE s.company_id = $1`, [companyId, customer.phone]);
    return Boolean(row?.host);
  }

  async myMeetings(customer: CustomerAccount, companyId: number) {
    await this.app.place(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT * FROM ca_meeting WHERE company_id = $1 AND cancelled_at IS NULL AND starts_at + (minutes || ' minutes')::interval > NOW() - INTERVAL '1 hour'
       ORDER BY starts_at LIMIT 100`, [companyId]);
    const items: Row[] = [];
    for (const m of rows) if (await this.invited(m, customer)) items.push(this.meetingView(m, { host: Number(m.host_account_id) === customer.id }, true));
    return { can_host: await this.canHost(customer, companyId), calls: this.config().enabled, items };
  }

  /** People with a host role schedule meetings for groups they are in (or people they can message). */
  async customerCreateMeeting(customer: CustomerAccount, companyId: number, input: Row) {
    await this.app.place(customer, companyId);
    if (!(await this.canHost(customer, companyId))) throw new ForbiddenException('Only the business (and people it lets host) can start meetings.');
    const audience = this.cleanAudience(input.audience);
    const mine: Row[] = await this.dataSource.query(`
      SELECT gm.group_id FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.company_id = $2 AND g.archived_at IS NULL WHERE gm.account_id = $1`,
    [customer.id, companyId]);
    const allowedGroups = new Set(mine.map((r) => Number(r.group_id)));
    const groupIds = (audience.group_ids ?? []).filter((id) => allowedGroups.has(id));
    const people: number[] = [];
    for (const id of audience.account_ids ?? []) if (!(await this.dms.whyNot(companyId, customer.id, id))) people.push(id);
    if (!groupIds.length && !people.length) throw new BadRequestException('Invite one of your groups or people you can message.');
    return this.createMeeting(companyId, { accountId: customer.id }, { ...input, audience: { group_ids: groupIds, account_ids: people } });
  }

  async join(customer: CustomerAccount, code: string) {
    const [m] = await this.dataSource.query(`SELECT * FROM ca_meeting WHERE code = $1`, [String(code ?? '')]);
    if (!m || m.cancelled_at) throw new NotFoundException('This meeting was not found or was cancelled.');
    await this.app.place(customer, Number(m.company_id));
    if (!(await this.invited(m, customer))) throw new ForbiddenException('You are not invited to this meeting.');
    const view = this.meetingView(m, {}, true);
    const host = Number(m.host_account_id) === customer.id;
    if (!host && view.state === 'upcoming') throw new BadRequestException(`The meeting opens 15 minutes before it starts (${new Date(m.starts_at).toISOString()}).`);
    if (view.state === 'over') throw new BadRequestException('This meeting is over.');
    const name = await this.customerName(Number(m.company_id), customer.id);
    // customers never get room-admin rights (a host can't mute or remove the business team)
    return { meeting: view, ...(await this.token(String(m.room), `ca-${customer.id}`, name, { minutes: this.minutesLeft(m) })) };
  }

  async meetingInfo(customer: CustomerAccount, code: string) {
    const [m] = await this.dataSource.query(`SELECT * FROM ca_meeting WHERE code = $1`, [String(code ?? '')]);
    if (!m) throw new NotFoundException('This meeting was not found.');
    await this.app.place(customer, Number(m.company_id));
    return this.meetingView(m, { invited: await this.invited(m, customer), host: Number(m.host_account_id) === customer.id }, true);
  }
}
