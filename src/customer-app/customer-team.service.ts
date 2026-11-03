import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BotAdminService } from '../bot-admin/bot-admin.service';
import { publicChatMediaUrl } from '../bot-admin/chat-media.store';
import { PusherService } from '../common/pusher.service';
import { normalizeWhatsapp } from '../verification/verification';
import { CustomerAppService, type TeamMember } from './customer-app.service';
import type { CustomerAccount } from './customer-auth';
import { CustomerCallsService } from './customer-calls.service';
import { CustomerCommunityService } from './customer-community.service';

type Row = Record<string, any>;
type Upload = { buffer: Buffer; mimetype: string; originalname: string };

/** "Kaumadi (#T2D3JF): Hello" – how a group message is saved in the Inbox. */
const GROUP_LINE = /^(.{1,80}?) \(#([A-Z0-9]{4,10})\)(?:: ([\s\S]*))?$/;
const ONLINE_MS = 70_000;

/**
 * The business's team inside its own app (owner + agents, logged in with their mobile number): the app chats of the
 * Inbox (customers and groups), replies as the business, calls and meetings. Uses the same Inbox rules as the dashboard:
 * the owner and supervisors see every chat, agents the chats assigned to them.
 */
@Injectable()
export class CustomerTeamService {
  private readonly pusher = new PusherService();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly app: CustomerAppService,
    private readonly inbox: BotAdminService,
    private readonly calls: CustomerCallsService,
    private readonly community: CustomerCommunityService,
  ) {}

  /** The team member behind this phone, as a dashboard user (same access rules as the dashboard). */
  async user(customer: CustomerAccount, companyId: number): Promise<{ user: AuthenticatedUser; member: TeamMember }> {
    const [enabled] = await this.dataSource.query(`SELECT 1 FROM ca_settings WHERE company_id = $1 AND enabled`, [companyId]);
    const member = enabled ? await this.app.teamMember(companyId, customer.phone) : null;
    if (!member) throw new ForbiddenException('This number is not in the business team.');
    return { member, user: { id: member.id, name: member.name, email: member.email, company_id: companyId, role: member.role, is_super_admin: false } };
  }

  private manager(user: AuthenticatedUser) { return user.role === 'admin' || user.role === 'supervisor'; }

  async me(customer: CustomerAccount, companyId: number) {
    const { member } = await this.user(customer, companyId);
    const [co] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    return { role: member.role, name: member.name, business: String(co?.name ?? ''), can_meet: member.role !== 'agent', calls: this.calls.config().enabled };
  }

  /* ───────── chats (the app part of the Inbox) ───────── */

  async chats(customer: CustomerAccount, companyId: number, search = '') {
    const { user } = await this.user(customer, companyId);
    const q = `%${search.trim().toLowerCase()}%`;
    const rows: Row[] = await this.dataSource.query(`
      SELECT bc.id, bc.assigned_agent_id, bc.agent_last_read_at, cu.external_user_id, cu.display_name, a.avatar_key, a.show_name, a.last_active_at, a.show_last_seen,
             last.content AS last_text, last.message_type AS last_type, last.direction AS last_direction, last.created_at AS last_at, last.source AS last_source,
             (SELECT COUNT(*)::int FROM bot_message m WHERE m.conversation_id = bc.id AND m.direction::text = 'inbound' AND m.message_type::text <> 'system'
                 AND m.created_at > COALESCE(bc.agent_last_read_at, 'epoch'::timestamptz)) AS unread
        FROM bot_conversation bc
        JOIN bot_channel_user cu ON cu.id = bc.bot_channel_user_id AND cu.company_id = $1 AND cu.platform = 'app'
        LEFT JOIN ca_account a ON cu.external_user_id = 'ca:' || a.id
        JOIN LATERAL (
          SELECT m.content, m.message_type::text AS message_type, m.direction::text AS direction, m.created_at, m.source FROM bot_message m
           WHERE m.conversation_id = bc.id AND m.message_type::text <> 'system' ORDER BY m.id DESC LIMIT 1) last ON TRUE
       WHERE bc.id = (SELECT MAX(x.id) FROM bot_conversation x WHERE x.bot_channel_user_id = cu.id)
         AND ($2::boolean OR bc.assigned_agent_id = $3)
         AND ($4 = '%%' OR LOWER(COALESCE(cu.display_name, '')) LIKE $4)
       ORDER BY last.created_at DESC LIMIT 300`, [companyId, this.manager(user), user.id, q]);
    return rows.map((r) => {
      const group = String(r.external_user_id).startsWith('cag:');
      const line = this.line(String(r.last_type), String(r.last_text ?? ''), group);
      return {
        id: Number(r.id), kind: group ? 'group' : 'customer', name: this.chatName(r), avatar_url: !group && r.show_name ? this.link(r.avatar_key) : null,
        online: !group && r.show_last_seen !== false && r.last_active_at ? Date.now() - new Date(r.last_active_at).getTime() < ONLINE_MS : false,
        unread: Number(r.unread ?? 0),
        last: { text: line.text, sender: group && r.last_direction === 'inbound' ? line.sender : null, from_us: r.last_direction === 'outbound', ai: r.last_source === 'sales_bot', at: r.last_at },
      };
    });
  }

  private chatName(r: Row) {
    const name = String(r.display_name ?? '').trim();
    return String(r.external_user_id).startsWith('cag:') ? name.replace(/ · group$/, '').replace(/^👥\s*/u, '') : name || 'Customer';
  }

  private link(key: string | null) { return key ? publicChatMediaUrl(key, 24 * 3600) : null; }

  /** A group line split into who wrote it and what they wrote. */
  private line(type: string, content: string, group: boolean) {
    const m = group ? GROUP_LINE.exec(content) : null;
    const text = m ? (m[3] ?? '') : content;
    return { sender: m ? { name: m[1], code: m[2] } : null, text: this.app.preview(type, type === 'image' && !text ? '[image]' : text) };
  }

  private async conversation(user: AuthenticatedUser, companyId: number, id: number) {
    const [c] = await this.dataSource.query(`
      SELECT bc.*, cu.external_user_id, cu.display_name, a.id AS account_id, a.avatar_key, a.show_name, a.last_active_at, a.show_last_seen
        FROM bot_conversation bc JOIN bot_channel_user cu ON cu.id = bc.bot_channel_user_id AND cu.company_id = $2 AND cu.platform = 'app'
        LEFT JOIN ca_account a ON cu.external_user_id = 'ca:' || a.id
       WHERE bc.id = $1`, [id, companyId]);
    if (!c) throw new NotFoundException('Chat not found.');
    if (!this.manager(user) && Number(c.assigned_agent_id) !== user.id) throw new ForbiddenException('This chat is assigned to someone else.');
    return c as Row;
  }

  async messages(customer: CustomerAccount, companyId: number, id: number, beforeId?: number) {
    const { user } = await this.user(customer, companyId);
    const c = await this.conversation(user, companyId, id);
    const group = String(c.external_user_id).startsWith('cag:');
    const rows: Row[] = await this.dataSource.query(`
      SELECT m.id, m.direction::text AS direction, m.message_type::text AS type, m.content, m.media_url, m.created_at, m.source, m.delivery_status,
             m.reply_to_message_id, u.name AS agent_name, m.sender_user_id
        FROM bot_message m JOIN bot_conversation bc ON bc.id = m.conversation_id
        LEFT JOIN app_user u ON u.id = m.sender_user_id
       WHERE bc.bot_channel_user_id = $1 AND m.message_type::text <> 'system' AND ($2::bigint IS NULL OR m.id < $2)
         AND ($3::boolean OR bc.id = $4)
       ORDER BY m.id DESC LIMIT 50`, [c.bot_channel_user_id, beforeId ?? null, this.manager(user), c.id]);
    let groupId: number | null = null;
    let members = 0;
    if (group) {
      groupId = Number(String(c.external_user_id).slice(4));
      const [g] = await this.dataSource.query(`SELECT COUNT(*)::int AS n FROM ca_group_member WHERE group_id = $1`, [groupId]);
      members = Number(g?.n ?? 0);
    }
    return {
      chat: {
        id: Number(c.id), kind: group ? 'group' : 'customer', name: this.chatName(c), group_id: groupId, members,
        account_id: c.account_id ? Number(c.account_id) : null, avatar_url: !group && c.show_name ? this.link(c.avatar_key) : null,
        online: !group && c.show_last_seen !== false && c.last_active_at ? Date.now() - new Date(c.last_active_at).getTime() < ONLINE_MS : false,
        last_seen: !group && c.show_last_seen !== false ? c.last_active_at ?? null : null,
      },
      has_more: rows.length === 50,
      messages: rows.reverse().map((r) => {
        const mine = r.direction === 'outbound';
        const line = !mine && group ? GROUP_LINE.exec(String(r.content ?? '')) : null;
        return {
          id: Number(r.id), mine, type: r.type, text: line ? line[3] ?? '' : String(r.content ?? ''), media_url: this.app.mediaLink(r.media_url), created_at: r.created_at,
          reply_to_id: r.reply_to_message_id ? Number(r.reply_to_message_id) : null,
          status: mine ? (r.delivery_status === 'read' ? 'read' : r.delivery_status === 'delivered' ? 'delivered' : 'sent') : undefined,
          sender: mine
            ? (r.source === 'sales_bot' || r.source === 'bot' ? 'AI' : r.agent_name ? String(r.agent_name) : null)
            : line ? `${line[1]} · #${line[2]}` : null,
        };
      }),
    };
  }

  async send(customer: CustomerAccount, companyId: number, id: number, input: { text?: string; file?: Upload | null }) {
    const { user } = await this.user(customer, companyId);
    await this.conversation(user, companyId, id);
    if (input.file) return this.inbox.sendConversationMedia(user, id, input.file, String(input.text ?? '').trim() || undefined);
    const text = String(input.text ?? '').trim();
    if (!text) throw new BadRequestException('Type a message.');
    return this.inbox.sendConversationMessage(user, id, text);
  }

  async read(customer: CustomerAccount, companyId: number, id: number) {
    const { user } = await this.user(customer, companyId);
    const c = await this.conversation(user, companyId, id);
    await this.dataSource.query(`UPDATE bot_conversation SET agent_last_read_at = NOW() WHERE id = $1`, [c.id]);
    const accountId = /^ca:(\d+)$/.exec(String(c.external_user_id))?.[1];
    if (accountId) this.app.pingCustomer(Number(accountId), companyId);
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: Number(c.id), platform: 'app', read: true });
    return { ok: true };
  }

  /* ───────── calls and meetings (same as the dashboard) ───────── */

  /** Agents may only take / see / end calls of chats assigned to them (or not assigned yet). */
  private async mayCall(user: AuthenticatedUser, companyId: number, call: Row) {
    if (this.manager(user)) return true;
    if (Number(call.caller_user_id) === user.id) return true;
    const assigned = call.account_id ? await this.calls.assignedAgent(companyId, Number(call.account_id)) : null;
    return assigned == null || assigned === user.id;
  }

  private async ownCall(user: AuthenticatedUser, companyId: number, callId: number) {
    const [c] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1 AND company_id = $2 AND scope = 'business'`, [callId, companyId]);
    if (!c || !(await this.mayCall(user, companyId, c))) throw new NotFoundException('Call not found.');
    return c as Row;
  }

  async ringing(customer: CustomerAccount, companyId: number) {
    const { user } = await this.user(customer, companyId);
    const list = await this.calls.ringing(companyId);
    const out: Row[] = [];
    for (const call of list) {
      const [row] = await this.dataSource.query(`SELECT * FROM ca_call WHERE id = $1`, [call.id]);
      if (row && (await this.mayCall(user, companyId, row))) out.push(call);
    }
    return out;
  }

  async call(customer: CustomerAccount, companyId: number, input: { conversation_id?: number; video?: boolean }) {
    const { user } = await this.user(customer, companyId);
    if (!Number.isInteger(input.conversation_id) || Number(input.conversation_id) <= 0) throw new BadRequestException('Open a chat to call.');
    await this.conversation(user, companyId, Number(input.conversation_id));
    return this.calls.staffCall(companyId, user.id, { conversation_id: Number(input.conversation_id), video: Boolean(input.video) });
  }

  async callStatus(customer: CustomerAccount, companyId: number, callId: number) {
    const { user } = await this.user(customer, companyId);
    await this.ownCall(user, companyId, callId);
    return this.calls.callStatus(companyId, callId);
  }

  async answer(customer: CustomerAccount, companyId: number, callId: number) {
    const { user } = await this.user(customer, companyId);
    await this.ownCall(user, companyId, callId);
    return this.calls.staffAnswer(companyId, user.id, callId);
  }

  async end(customer: CustomerAccount, companyId: number, callId: number) {
    const { user } = await this.user(customer, companyId);
    const c = await this.ownCall(user, companyId, callId);
    // an agent can't hang up someone else's live call
    if (!this.manager(user) && c.status === 'active' && Number(c.answered_by_user_id) !== user.id && Number(c.caller_user_id) !== user.id) throw new ForbiddenException('Someone else is on this call.');
    return this.calls.staffEnd(companyId, callId);
  }

  async meetings(customer: CustomerAccount, companyId: number) {
    await this.user(customer, companyId);
    return this.calls.businessMeetings(companyId);
  }

  private async meetingManager(customer: CustomerAccount, companyId: number) {
    const { user } = await this.user(customer, companyId);
    if (!this.manager(user)) throw new ForbiddenException('Only the owner and supervisors make meetings.');
    return user;
  }

  async createMeeting(customer: CustomerAccount, companyId: number, input: Row) {
    const user = await this.meetingManager(customer, companyId);
    return this.calls.businessCreateMeeting(companyId, user.id, input ?? {});
  }

  async cancelMeeting(customer: CustomerAccount, companyId: number, meetingId: number) {
    await this.meetingManager(customer, companyId);
    return this.calls.cancelMeeting(companyId, meetingId);
  }

  async shareMeeting(customer: CustomerAccount, companyId: number, meetingId: number, groupIds: unknown) {
    const user = await this.meetingManager(customer, companyId);
    return this.calls.shareToGroups(companyId, user.id, meetingId, groupIds, (groupId, text) => this.community.businessPost(companyId, user.id, groupId, { text }));
  }

  async joinMeeting(customer: CustomerAccount, companyId: number, meetingId: number) {
    const { user } = await this.user(customer, companyId);
    // agents join as participants; the owner and supervisors host (can mute / remove)
    return this.calls.staffJoin(companyId, user.id, meetingId, this.manager(user));
  }

  async groups(customer: CustomerAccount, companyId: number) {
    await this.user(customer, companyId);
    const rows: Row[] = await this.dataSource.query(`
      SELECT g.id, g.name, (SELECT COUNT(*)::int FROM ca_group_member m WHERE m.group_id = g.id) AS members
        FROM ca_group g WHERE g.company_id = $1 AND g.archived_at IS NULL ORDER BY g.name`, [companyId]);
    return rows.map((g) => ({ id: Number(g.id), name: g.name, members: Number(g.members) }));
  }

  /* ───────── dashboard: who of the team can use the app ───────── */

  async teamList(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT u.id, u.name, u.email, u.team_role, u.whatsapp_number, u.whatsapp_verified_at, u.access_disabled, c.admin_user_id
        FROM app_user u JOIN companies c ON c.id = u.company_id
       WHERE u.company_id = $1 AND NOT u.is_super_admin ORDER BY (u.id = c.admin_user_id) DESC, u.name`, [companyId]);
    return rows.map((r) => {
      const owner = Number(r.id) === Number(r.admin_user_id);
      const mobile = r.whatsapp_number || null;
      return {
        id: Number(r.id), name: r.name, email: r.email, role: owner ? 'admin' : r.team_role === 'supervisor' ? 'supervisor' : 'agent', owner,
        mobile: mobile ? normalizeWhatsapp(String(mobile)) : null, verified: Boolean(r.whatsapp_verified_at), disabled: Boolean(r.access_disabled),
        editable: !owner,
      };
    });
  }

  /** The owner saves an agent's mobile number – the agent confirms it with the SMS code when they first log into the app. */
  async setMobile(companyId: number, userId: number, raw: unknown) {
    const [u] = await this.dataSource.query(`
      SELECT u.id, u.whatsapp_number, c.admin_user_id FROM app_user u JOIN companies c ON c.id = u.company_id WHERE u.id = $1 AND u.company_id = $2`, [userId, companyId]);
    if (!u) throw new NotFoundException('Team member not found.');
    if (Number(u.id) === Number(u.admin_user_id)) throw new BadRequestException('Change your own mobile number in Settings → Account (it is checked with a code).');
    const text = String(raw ?? '').trim();
    const mobile = text ? normalizeWhatsapp(text) : null;
    if (mobile && (mobile.length < 10 || mobile.length > 15)) throw new BadRequestException('Enter a mobile number, e.g. 077 123 4567.');
    if (mobile) {
      const others: Row[] = await this.dataSource.query(`SELECT whatsapp_number FROM app_user WHERE company_id = $1 AND id <> $2 AND whatsapp_number IS NOT NULL`, [companyId, userId]);
      if (others.some((o) => normalizeWhatsapp(String(o.whatsapp_number)) === mobile)) throw new ConflictException('Another team member already uses this number.');
      // a customer's number must never become a team login (they would see and answer as the business)
      const [customerRow] = await this.dataSource.query(`SELECT 1 FROM ca_app_member WHERE company_id = $1 AND phone = $2`, [companyId, mobile]);
      if (customerRow) throw new ConflictException('This number is on your app\'s customer list. Use the agent\'s own mobile number (or remove it from Customers first).');
    }
    const changed = (u.whatsapp_number ? normalizeWhatsapp(String(u.whatsapp_number)) : null) !== mobile;
    if (changed) await this.dataSource.query(`UPDATE app_user SET whatsapp_number = $2, whatsapp_verified_at = NULL WHERE id = $1`, [userId, mobile]);
    this.app.forgetTeam();
    return { mobile, verified: changed ? false : undefined };
  }
}
