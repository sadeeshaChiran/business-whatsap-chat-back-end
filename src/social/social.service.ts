import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { publicChatMediaUrl, saveChatMedia } from '../bot-admin/chat-media.store';
import { PusherService } from '../common/pusher.service';
import { SocialHook } from '../common/social-hook';
import { GraphError, graphRequest } from '../marketing/graph';
import { TokenQuotaService } from '../platform/token-quota.service';
import { SalesBotContextService } from '../sales-bot/sales-bot-context.service';

type Platform = 'facebook' | 'instagram';
type Page = { page_id: string; page_name: string | null; page_access_token: string; instagram_business_account_id: string | null };
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Social section: Facebook Page + Instagram comments (reply, private reply, hide, delete, like, AI suggestions,
 * AI auto-reply), posts (publish, schedule, edit, delete), Page / Instagram profile and analytics.
 * Uses the Page connection of the Channels screen (page token) – no extra login.
 */
@Injectable()
export class SocialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialService.name);
  private readonly pusher = new PusherService();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contextService: SalesBotContextService,
    private readonly quota: TokenQuotaService,
  ) {}

  onModuleInit() {
    SocialHook.register((body) => this.captureWebhook(body));
    this.timer = setInterval(() => void this.publishDue(), 60_000);
    this.syncTimer = setInterval(() => void this.autoSync(), 2 * 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  /* ───────────────────────── basics ───────────────────────── */

  private async adminCompany(user: AuthenticatedUser): Promise<number> {
    const [row] = await this.dataSource.query(`SELECT id, admin_user_id FROM companies WHERE id = $1`, [user.company_id]);
    if (!row) throw new ForbiddenException('No company.');
    return Number(row.id);
  }

  private async page(companyId: number): Promise<Page> {
    const [row] = await this.dataSource.query(
      `SELECT page_id, page_name, page_access_token, instagram_business_account_id FROM meta_page_connections
        WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [companyId]);
    if (!row?.page_access_token) throw new BadRequestException('Connect your Facebook Page first (Channels → Messenger).');
    return row;
  }

  private graphError(error: unknown, hint = ''): never {
    if (error instanceof GraphError) {
      const permission = /permission|scope|\(#10\)|\(#200\)|\(#190\)/i.test(error.message);
      throw new BadRequestException(`Meta: ${error.message}${permission ? ' – reconnect the Page (Channels → Messenger → Switch Page) to grant the new permissions.' : ''}${hint}`);
    }
    throw error;
  }

  async settings(companyId: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM social_settings WHERE company_id = $1`, [companyId]);
    return row ?? { company_id: companyId, auto_reply: 'off', auto_dm: false, auto_hide_spam: true, last_sync_at: null };
  }

  async saveSettings(user: AuthenticatedUser, dto: { auto_reply?: string; auto_dm?: boolean; auto_hide_spam?: boolean }) {
    const companyId = await this.adminCompany(user);
    const current = await this.settings(companyId);
    const next = {
      auto_reply: ['off', 'suggest', 'reply'].includes(String(dto.auto_reply)) ? dto.auto_reply : current.auto_reply,
      auto_dm: dto.auto_dm ?? current.auto_dm,
      auto_hide_spam: dto.auto_hide_spam ?? current.auto_hide_spam,
    };
    await this.dataSource.query(`
      INSERT INTO social_settings (company_id, auto_reply, auto_dm, auto_hide_spam) VALUES ($1, $2, $3, $4)
      ON CONFLICT (company_id) DO UPDATE SET auto_reply = EXCLUDED.auto_reply, auto_dm = EXCLUDED.auto_dm,
        auto_hide_spam = EXCLUDED.auto_hide_spam, updated_at = NOW()`, [companyId, next.auto_reply, next.auto_dm, next.auto_hide_spam]);
    return this.settings(companyId);
  }

  /* ───────────────────────── Page / Instagram profile ───────────────────────── */

  async overview(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    const [connection] = await this.dataSource.query(
      `SELECT page_id, page_name, page_access_token, instagram_business_account_id, scopes FROM meta_page_connections
        WHERE company_id = $1 AND status = 'CONNECTED' ORDER BY updated_at DESC LIMIT 1`, [companyId]);
    const settings = await this.settings(companyId);
    if (!connection?.page_access_token) return { connected: false, settings };
    const required = ['pages_manage_engagement', 'pages_read_user_content', 'pages_manage_posts', 'read_insights', 'instagram_manage_comments', 'instagram_content_publish', 'instagram_manage_insights'];
    const granted = String(connection.scopes ?? '').split(/[\s,]+/).filter(Boolean);
    const page = await graphRequest<Record<string, unknown>>('GET', `/${connection.page_id}`, connection.page_access_token,
      { fields: 'id,name,about,category,fan_count,followers_count,link,picture.type(large){url}' }).catch(() => null);
    const instagram = connection.instagram_business_account_id
      ? await graphRequest<Record<string, unknown>>('GET', `/${connection.instagram_business_account_id}`, connection.page_access_token,
        { fields: 'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website' }).catch(() => null)
      : null;
    const [counts] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open_comments,
             COUNT(*) FILTER (WHERE created_time > NOW() - INTERVAL '7 days')::int AS comments_7d
        FROM social_comment WHERE company_id = $1`, [companyId]);
    return {
      connected: true, settings, counts,
      missing_permissions: granted.length ? required.filter((scope) => !granted.includes(scope)) : [],
      facebook: {
        id: connection.page_id, name: page?.name ?? connection.page_name, about: page?.about ?? '', category: page?.category ?? '',
        followers: num(page?.followers_count ?? page?.fan_count), likes: num(page?.fan_count), link: page?.link ?? null,
        picture: ((page?.picture as { data?: { url?: string } })?.data?.url) ?? null,
      },
      instagram: instagram ? {
        id: instagram.id, username: instagram.username, name: instagram.name, bio: instagram.biography ?? '',
        followers: num(instagram.followers_count), following: num(instagram.follows_count), posts: num(instagram.media_count),
        picture: instagram.profile_picture_url ?? null, website: instagram.website ?? null,
      } : null,
    };
  }

  /* ───────────────────────── comments ───────────────────────── */

  private async upsertComment(companyId: number, c: {
    platform: Platform; comment_id: string; post_id?: string | null; parent_id?: string | null; author_id?: string | null; author_name?: string;
    message?: string; post_text?: string; post_link?: string | null; created_time?: Date; is_hidden?: boolean;
  }): Promise<{ id: number; isNew: boolean }> {
    const [row] = await this.dataSource.query(`
      INSERT INTO social_comment (company_id, platform, comment_id, post_id, parent_id, author_id, author_name, message, post_text, post_link, created_time, is_hidden, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 THEN 'hidden' ELSE 'open' END)
      ON CONFLICT (comment_id) DO UPDATE SET message = EXCLUDED.message, is_hidden = EXCLUDED.is_hidden,
        post_text = COALESCE(NULLIF(EXCLUDED.post_text, ''), social_comment.post_text), post_link = COALESCE(EXCLUDED.post_link, social_comment.post_link),
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted`,
      [companyId, c.platform, c.comment_id, c.post_id ?? null, c.parent_id ?? null, c.author_id ?? null, (c.author_name ?? '').slice(0, 250),
        c.message ?? '', (c.post_text ?? '').slice(0, 3000), c.post_link ?? null, c.created_time ?? new Date(), Boolean(c.is_hidden)]);
    return { id: Number(row.id), isNew: row.inserted === true };
  }

  /** Our own reply found on Meta → the parent comment counts as answered. */
  private async markAnswered(parentId: string, text: string, replyId: string, at: Date) {
    await this.dataSource.query(`
      UPDATE social_comment SET status = 'replied', our_reply = COALESCE(our_reply, $2), reply_id = COALESCE(reply_id, $3),
             replied_at = COALESCE(replied_at, $4), updated_at = NOW()
       WHERE comment_id = $1 AND status = 'open'`, [parentId, text, replyId, at]);
  }

  /** Real-time: Page "feed" changes and Instagram "comments" changes from the Meta webhook. */
  async captureWebhook(body: unknown) {
    const payload = body as { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: Record<string, any> }> }> };
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        if (payload.object === 'page' && change.field === 'feed' && v.item === 'comment') {
          const [conn] = await this.dataSource.query(`SELECT company_id FROM meta_page_connections WHERE page_id = $1 AND status = 'CONNECTED' LIMIT 1`, [String(entry.id)]);
          if (!conn) continue;
          const companyId = Number(conn.company_id);
          if (v.verb === 'remove') {
            await this.dataSource.query(`UPDATE social_comment SET status = 'deleted', updated_at = NOW() WHERE comment_id = $1`, [String(v.comment_id)]);
            continue;
          }
          const fromPage = String(v.from?.id ?? '') === String(entry.id);
          const created = v.created_time ? new Date(Number(v.created_time) * 1000) : new Date();
          if (fromPage) {
            if (v.parent_id && v.parent_id !== v.post_id) await this.markAnswered(String(v.parent_id), String(v.message ?? ''), String(v.comment_id), created);
            continue;
          }
          const saved = await this.upsertComment(companyId, {
            platform: 'facebook', comment_id: String(v.comment_id), post_id: v.post_id ? String(v.post_id) : null,
            parent_id: v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : null, author_id: v.from?.id ? String(v.from.id) : null,
            author_name: String(v.from?.name ?? ''), message: String(v.message ?? ''), created_time: created,
          });
          if (saved.isNew) await this.autoHandle(companyId, saved.id);
        }
        if (payload.object === 'instagram' && change.field === 'comments') {
          const [conn] = await this.dataSource.query(`SELECT company_id FROM meta_page_connections WHERE instagram_business_account_id = $1 AND status = 'CONNECTED' LIMIT 1`, [String(entry.id)]);
          if (!conn) continue;
          const companyId = Number(conn.company_id);
          if (String(v.from?.id ?? '') === String(entry.id)) {
            if (v.parent_id) await this.markAnswered(String(v.parent_id), String(v.text ?? ''), String(v.id), new Date());
            continue;
          }
          const saved = await this.upsertComment(companyId, {
            platform: 'instagram', comment_id: String(v.id), post_id: v.media?.id ? String(v.media.id) : null, parent_id: v.parent_id ? String(v.parent_id) : null,
            author_id: v.from?.id ? String(v.from.id) : null, author_name: String(v.from?.username ?? ''), message: String(v.text ?? ''), created_time: new Date(),
          });
          if (saved.isNew) await this.autoHandle(companyId, saved.id);
        }
      }
    }
  }

  /** Pulls comments of the latest posts (works without the webhook; also fills post text / links). */
  async sync(user: AuthenticatedUser) {
    return this.syncCompany(await this.adminCompany(user));
  }

  /** Every 2 minutes: pull new comments for companies with AI on, so auto-reply works even when Meta's webhook does not arrive. */
  async autoSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const rows = await this.dataSource.query(`
        SELECT DISTINCT s.company_id FROM social_settings s
          JOIN meta_page_connections m ON m.company_id = s.company_id AND m.status = 'CONNECTED'
         WHERE s.auto_reply <> 'off'`);
      for (const row of rows) {
        await this.syncCompany(Number(row.company_id)).catch((error: unknown) =>
          this.logger.warn(`auto sync ${row.company_id}: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      this.logger.warn(`auto sync: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncing = false;
    }
  }

  private async syncCompany(companyId: number) {
    const page = await this.page(companyId);
    let added = 0;
    const fresh: Array<{ id: number; created: Date }> = [];
    try {
      const posts = await graphRequest<{ data: Array<{ id: string; message?: string; permalink_url?: string }> }>(
        'GET', `/${page.page_id}/posts`, page.page_access_token, { fields: 'id,message,permalink_url,created_time', limit: '15' });
      for (const post of posts.data ?? []) {
        const comments = await graphRequest<{ data: Array<{ id: string; message?: string; from?: { id: string; name: string }; created_time?: string; parent?: { id: string }; is_hidden?: boolean }> }>(
          'GET', `/${post.id}/comments`, page.page_access_token,
          { fields: 'id,message,from,created_time,parent{id},is_hidden', filter: 'stream', order: 'reverse_chronological', limit: '50' }).catch(() => ({ data: [] }));
        for (const c of [...(comments.data ?? [])].reverse()) {
          if (c.from?.id === page.page_id) {
            if (c.parent?.id) await this.markAnswered(c.parent.id, c.message ?? '', c.id, c.created_time ? new Date(c.created_time) : new Date());
            continue;
          }
          const saved = await this.upsertComment(companyId, {
            platform: 'facebook', comment_id: c.id, post_id: post.id, parent_id: c.parent?.id ?? null, author_id: c.from?.id ?? null,
            author_name: c.from?.name ?? '', message: c.message ?? '', post_text: post.message ?? '', post_link: post.permalink_url ?? null,
            created_time: c.created_time ? new Date(c.created_time) : new Date(), is_hidden: c.is_hidden,
          });
          if (saved.isNew) { added += 1; fresh.push({ id: saved.id, created: c.created_time ? new Date(c.created_time) : new Date() }); }
        }
      }
      if (page.instagram_business_account_id) {
        const media = await graphRequest<{ data: Array<{ id: string; caption?: string; permalink?: string }> }>(
          'GET', `/${page.instagram_business_account_id}/media`, page.page_access_token, { fields: 'id,caption,permalink,timestamp', limit: '15' });
        for (const m of media.data ?? []) {
          type IgComment = { id: string; text?: string; username?: string; from?: { id: string; username?: string }; timestamp?: string; hidden?: boolean; replies?: { data?: IgComment[] } };
          const comments = await graphRequest<{ data: IgComment[] }>('GET', `/${m.id}/comments`, page.page_access_token,
            { fields: 'id,text,username,from,timestamp,hidden,replies{id,text,username,from,timestamp}', limit: '50' }).catch(() => ({ data: [] as IgComment[] }));
          for (const c of comments.data ?? []) {
            const own = c.from?.id === page.instagram_business_account_id;
            if (!own) {
              const saved = await this.upsertComment(companyId, {
                platform: 'instagram', comment_id: c.id, post_id: m.id, author_id: c.from?.id ?? null, author_name: c.username ?? c.from?.username ?? '',
                message: c.text ?? '', post_text: m.caption ?? '', post_link: m.permalink ?? null, created_time: c.timestamp ? new Date(c.timestamp) : new Date(), is_hidden: c.hidden,
              });
              if (saved.isNew) { added += 1; fresh.push({ id: saved.id, created: c.timestamp ? new Date(c.timestamp) : new Date() }); }
            }
            for (const r of c.replies?.data ?? []) {
              if (r.from?.id === page.instagram_business_account_id) await this.markAnswered(c.id, r.text ?? '', r.id, r.timestamp ? new Date(r.timestamp) : new Date());
            }
          }
        }
      }
    } catch (error) {
      this.graphError(error);
    }
    // the webhook may not have delivered these: auto-answer only recent ones, never old history
    const cutoff = Date.now() - 2 * 86_400_000;
    for (const c of fresh) if (c.created.getTime() > cutoff) await this.autoHandle(companyId, c.id);
    await this.dataSource.query(`
      INSERT INTO social_settings (company_id, last_sync_at) VALUES ($1, NOW())
      ON CONFLICT (company_id) DO UPDATE SET last_sync_at = NOW()`, [companyId]);
    return { added };
  }

  async comments(user: AuthenticatedUser, query: { status?: string; platform?: string; search?: string }) {
    const companyId = await this.adminCompany(user);
    const rows = await this.dataSource.query(`
      SELECT * FROM social_comment
       WHERE company_id = $1 AND status <> 'deleted'
         AND ($2::text IS NULL OR $2 = 'all' OR status = $2)
         AND ($3::text IS NULL OR platform = $3)
         AND ($4 = '' OR LOWER(message) LIKE '%' || $4 || '%' OR LOWER(author_name) LIKE '%' || $4 || '%')
       ORDER BY (status = 'open') DESC, created_time DESC LIMIT 200`,
      [companyId, query.status || 'open', query.platform || null, String(query.search ?? '').trim().toLowerCase()]);
    const [counts] = await this.dataSource.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open, COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
             COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden, COUNT(*) FILTER (WHERE status = 'done')::int AS done
        FROM social_comment WHERE company_id = $1`, [companyId]);
    return { comments: rows, counts };
  }

  private async comment(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT * FROM social_comment WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Comment not found.');
    return row;
  }

  async reply(user: AuthenticatedUser, id: number, message: string, byAi = false) {
    const companyId = await this.adminCompany(user);
    return this.replyAs(companyId, id, message, Number(user.id), byAi);
  }

  private async replyAs(companyId: number, id: number, message: string, userId: number | null, byAi: boolean) {
    const text = message.trim();
    if (!text) throw new BadRequestException('Write a reply.');
    const c = await this.comment(companyId, id);
    const page = await this.page(companyId);
    try {
      const result = c.platform === 'instagram'
        ? await graphRequest<{ id: string }>('POST', `/${c.comment_id}/replies`, page.page_access_token, { message: text })
        : await graphRequest<{ id: string }>('POST', `/${c.comment_id}/comments`, page.page_access_token, { message: text });
      await this.dataSource.query(`
        UPDATE social_comment SET status = 'replied', our_reply = $2, reply_id = $3, replied_at = NOW(), replied_by = $4, replied_by_ai = $5, updated_at = NOW()
         WHERE id = $1`, [id, text, result.id ?? null, userId, byAi]);
    } catch (error) {
      this.graphError(error);
    }
    return this.comment(companyId, id);
  }

  /** Private reply: one message to the commenter's Messenger / Instagram inbox (Meta allows one per comment, within 7 days). */
  async privateReply(user: AuthenticatedUser, id: number, message: string) {
    const companyId = await this.adminCompany(user);
    return this.privateReplyAs(companyId, id, message);
  }

  private async privateReplyAs(companyId: number, id: number, message: string) {
    const text = message.trim();
    if (!text) throw new BadRequestException('Write the private message.');
    const c = await this.comment(companyId, id);
    if (c.private_replied_at) throw new BadRequestException('A private reply was already sent for this comment (Meta allows one).');
    const page = await this.page(companyId);
    const sender = c.platform === 'instagram' ? page.instagram_business_account_id : page.page_id;
    if (!sender) throw new BadRequestException('Instagram is not linked to this Page.');
    try {
      const sent = await graphRequest<{ recipient_id?: string; message_id?: string }>('POST', `/${sender}/messages`, page.page_access_token,
        { recipient: { comment_id: c.comment_id }, message: { text } });
      await this.dataSource.query(`UPDATE social_comment SET private_reply = $2, private_replied_at = NOW(), updated_at = NOW() WHERE id = $1`, [id, text]);
      if (sent?.recipient_id) {
        await this.saveToInbox(companyId, c.platform === 'instagram' ? 'instagram' : 'messenger', sender, String(sent.recipient_id),
          c.author_name ?? '', text, sent.message_id ?? null).catch((error: unknown) =>
          this.logger.warn(`private reply ${id} → inbox: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      this.graphError(error, ' (private replies work within 7 days of the comment)');
    }
    return this.comment(companyId, id);
  }

  async hide(user: AuthenticatedUser, id: number, hidden: boolean) {
    const companyId = await this.adminCompany(user);
    const c = await this.comment(companyId, id);
    const page = await this.page(companyId);
    try {
      await graphRequest('POST', `/${c.comment_id}`, page.page_access_token, c.platform === 'instagram' ? { hide: hidden } : { is_hidden: hidden });
      await this.dataSource.query(`UPDATE social_comment SET is_hidden = $2, status = CASE WHEN $2 THEN 'hidden' WHEN our_reply IS NOT NULL THEN 'replied' ELSE 'open' END, updated_at = NOW() WHERE id = $1`, [id, hidden]);
    } catch (error) {
      this.graphError(error);
    }
    return this.comment(companyId, id);
  }

  async remove(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    const c = await this.comment(companyId, id);
    const page = await this.page(companyId);
    try {
      await graphRequest('DELETE', `/${c.comment_id}`, page.page_access_token);
      await this.dataSource.query(`UPDATE social_comment SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [id]);
    } catch (error) {
      this.graphError(error);
    }
    return { id, deleted: true };
  }

  async like(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    const c = await this.comment(companyId, id);
    if (c.platform !== 'facebook') throw new BadRequestException('Instagram does not allow liking comments through the API.');
    const page = await this.page(companyId);
    try {
      await graphRequest('POST', `/${c.comment_id}/likes`, page.page_access_token);
      await this.dataSource.query(`UPDATE social_comment SET liked = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
    } catch (error) {
      this.graphError(error);
    }
    return this.comment(companyId, id);
  }

  /** "Done" without replying (e.g. a simple 👍 comment). */
  async markDone(user: AuthenticatedUser, id: number, done: boolean) {
    const companyId = await this.adminCompany(user);
    await this.comment(companyId, id);
    await this.dataSource.query(`UPDATE social_comment SET status = CASE WHEN $2 THEN 'done' WHEN our_reply IS NOT NULL THEN 'replied' ELSE 'open' END, updated_at = NOW() WHERE id = $1`, [id, done]);
    return this.comment(companyId, id);
  }

  /** Shows a private reply in the chat inbox (same contact + conversation the customer's Messenger / Instagram answers will use). */
  private async saveToInbox(companyId: number, platform: 'messenger' | 'instagram', accountId: string, customerId: string, name: string, text: string, mid: string | null) {
    let [user] = await this.dataSource.query(
      `SELECT id FROM bot_channel_user WHERE company_id = $1 AND platform = $2 AND source_account_id = $3 AND external_user_id = $4 LIMIT 1`,
      [companyId, platform, accountId, customerId]);
    if (!user) {
      [user] = await this.dataSource.query(`
        INSERT INTO bot_channel_user (company_id, platform, external_user_id, source_account_id, display_name, language, language_locked, bot_enabled, manual_mode, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, 'English', FALSE, FALSE, FALSE, NOW()) RETURNING id`,
        [companyId, platform, customerId, accountId, (name || customerId).slice(0, 250)]);
    }
    let [conversation] = await this.dataSource.query(
      `SELECT id, status FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
    if (!conversation || conversation.status === 'closed') {
      [conversation] = await this.dataSource.query(`
        INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, last_message_at) VALUES ($1, 'open', 'unassigned', NOW()) RETURNING id`, [user.id]);
    } else {
      await this.dataSource.query(`UPDATE bot_conversation SET last_message_at = NOW() WHERE id = $1`, [conversation.id]);
    }
    await this.dataSource.query(`
      INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, source)
      VALUES ($1, 'outbound', 'text', $2, $3, 'sent', $4, 'social-private-reply')`, [conversation.id, platform, mid, text]);
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { conversation_id: conversation.id, platform, direction: 'outbound' });
  }

  /* ───── AI ───── */

  private async callBot<T>(path: string, body: Record<string, unknown>, companyId: number): Promise<T> {
    const base = String(process.env.SALES_BOT_URL ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new BadRequestException('The AI is not configured (SALES_BOT_URL).');
    if (!(await this.quota.canBotReply(companyId))) throw new ForbiddenException('Your AI credits are used up – buy a top-up in Billing.');
    const context = await this.contextService.build(companyId, null, 'messenger');
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Key': String(process.env.SALES_BOT_API_KEY ?? '') },
      body: JSON.stringify({ ...body, company_id: companyId, context }), signal: AbortSignal.timeout(60_000),
    }).catch((error: unknown) => { throw new BadRequestException(`The AI is not reachable: ${error instanceof Error ? error.message : String(error)}`); });
    if (!response.ok) throw new BadRequestException(`The AI could not answer (${response.status}).`);
    const result = (await response.json()) as T & { usage?: Record<string, number | string> };
    const u = result.usage;
    if (u) {
      await this.dataSource.query(`
        INSERT INTO bot_ai_usage (company_id, model, input_tokens, cached_tokens, output_tokens, calls, cost_usd, latency_ms, is_test)
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7, FALSE)`,
        [companyId, String(u.model ?? ''), num(u.input_tokens), num(u.cached_tokens), num(u.output_tokens), num(u.cost_usd), num(u.latency_ms)]).catch(() => undefined);
      this.quota.forget(companyId);
    }
    return result;
  }

  async suggest(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    return this.suggestFor(companyId, id);
  }

  private async suggestFor(companyId: number, id: number) {
    const c = await this.comment(companyId, id);
    const ai = await this.callBot<{ reply: string; dm: string; intent: string; hide: boolean }>('/social/comment-reply', {
      platform: c.platform, post_text: c.post_text, comment: c.message, author: c.author_name,
    }, companyId);
    await this.dataSource.query(`UPDATE social_comment SET ai_reply = $2, ai_dm = $3, ai_intent = $4, updated_at = NOW() WHERE id = $1`,
      [id, ai.reply ?? '', ai.dm ?? '', String(ai.intent ?? '').slice(0, 20)]);
    return { ...ai, comment: await this.comment(companyId, id) };
  }

  /** New comment: AI suggestion or AI reply (+ private message) depending on the settings; spam can be hidden. */
  private async autoHandle(companyId: number, id: number) {
    const settings = await this.settings(companyId);
    if (settings.auto_reply === 'off') return;
    try {
      if ((await this.comment(companyId, id)).status !== 'open') return; // already answered / hidden
      const ai = await this.suggestFor(companyId, id);
      if (ai.hide && settings.auto_hide_spam) {
        const c = await this.comment(companyId, id);
        const page = await this.page(companyId);
        await graphRequest('POST', `/${c.comment_id}`, page.page_access_token, c.platform === 'instagram' ? { hide: true } : { is_hidden: true });
        await this.dataSource.query(`UPDATE social_comment SET is_hidden = TRUE, status = 'hidden', updated_at = NOW() WHERE id = $1`, [id]);
        return;
      }
      if (settings.auto_reply !== 'reply' || !ai.reply) return;
      await this.replyAs(companyId, id, ai.reply, null, true);
      if (settings.auto_dm && ai.dm) await this.privateReplyAs(companyId, id, ai.dm).catch(() => undefined);
    } catch (error) {
      this.logger.warn(`auto-reply ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async caption(user: AuthenticatedUser, dto: { topic: string; language?: string; tone?: string; platform?: string }) {
    const companyId = await this.adminCompany(user);
    if (!dto.topic?.trim()) throw new BadRequestException('Write what the post is about.');
    return this.callBot<{ caption: string; hashtags: string[] }>('/social/caption', {
      topic: dto.topic, language: dto.language ?? 'english', tone: dto.tone ?? 'friendly', platform: dto.platform ?? 'facebook',
    }, companyId);
  }

  /* ───────────────────────── posts ───────────────────────── */

  async posts(user: AuthenticatedUser, platform: string) {
    const companyId = await this.adminCompany(user);
    const page = await this.page(companyId);
    try {
      if (platform === 'instagram') {
        if (!page.instagram_business_account_id) return { posts: [], instagram_linked: false };
        const media = await graphRequest<{ data: Array<Record<string, any>> }>('GET', `/${page.instagram_business_account_id}/media`, page.page_access_token,
          { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count', limit: '30' });
        return {
          instagram_linked: true,
          posts: (media.data ?? []).map((m) => ({
            id: m.id, platform: 'instagram', text: m.caption ?? '', image: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url, type: m.media_type,
            link: m.permalink, created_time: m.timestamp, likes: num(m.like_count), comments: num(m.comments_count), shares: null,
            can_edit: false, can_delete: false,
          })),
        };
      }
      const posts = await graphRequest<{ data: Array<Record<string, any>> }>('GET', `/${page.page_id}/posts`, page.page_access_token, {
        fields: 'id,message,created_time,full_picture,permalink_url,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)', limit: '30',
      });
      return {
        posts: (posts.data ?? []).map((p) => ({
          id: p.id, platform: 'facebook', text: p.message ?? '', image: p.full_picture ?? null, type: p.full_picture ? 'IMAGE' : 'TEXT',
          link: p.permalink_url, created_time: p.created_time, likes: num(p.reactions?.summary?.total_count),
          comments: num(p.comments?.summary?.total_count), shares: num(p.shares?.count), can_edit: true, can_delete: true,
        })),
      };
    } catch (error) {
      this.graphError(error);
    }
  }

  /** Photo for a post: stored by us, Meta downloads it from a public signed link. */
  async uploadMedia(user: AuthenticatedUser, file?: { buffer: Buffer; mimetype: string; originalname: string }) {
    const companyId = await this.adminCompany(user);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a photo.');
    if (!/^image\/(jpeg|png)$/.test(file.mimetype)) throw new BadRequestException('Use a JPG or PNG photo (Instagram accepts only these).');
    if (file.buffer.length > 8 * 1024 * 1024) throw new BadRequestException('The photo is larger than 8 MB.');
    const key = saveChatMedia(companyId, file.buffer, file.mimetype, file.originalname || 'photo.jpg');
    const url = publicChatMediaUrl(key, 7 * 24 * 3600);
    if (!url) throw new BadRequestException('PUBLIC_API_BASE_URL is not set on the server – Meta cannot download the photo.');
    return { url };
  }

  async createPost(user: AuthenticatedUser, dto: { platforms: string[]; message?: string; link?: string; media_urls?: string[]; scheduled_at?: string | null }) {
    const companyId = await this.adminCompany(user);
    const platforms = [...new Set((dto.platforms ?? []).filter((p) => p === 'facebook' || p === 'instagram'))] as Platform[];
    if (!platforms.length) throw new BadRequestException('Choose Facebook and / or Instagram.');
    const media = (dto.media_urls ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 10);
    if (!dto.message?.trim() && !media.length && !dto.link) throw new BadRequestException('Write something or add a photo.');
    if (platforms.includes('instagram') && !media.length) throw new BadRequestException('Instagram posts need at least one photo.');
    const page = await this.page(companyId);
    if (platforms.includes('instagram') && !page.instagram_business_account_id) throw new BadRequestException('Instagram is not linked to this Facebook Page.');
    if (dto.scheduled_at) {
      const when = new Date(dto.scheduled_at);
      if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000) throw new BadRequestException('Choose a time at least 1 minute from now.');
      const [row] = await this.dataSource.query(`
        INSERT INTO social_post_schedule (company_id, platforms, message, link, media_urls, scheduled_at, created_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
        [companyId, platforms, dto.message ?? '', dto.link ?? null, JSON.stringify(media), when, user.id]);
      return { scheduled: row };
    }
    return { published: await this.publish(companyId, platforms, dto.message ?? '', dto.link ?? null, media) };
  }

  private async publish(companyId: number, platforms: Platform[], message: string, link: string | null, media: string[]) {
    const page = await this.page(companyId);
    const results: Record<string, { id?: string; error?: string }> = {};
    if (platforms.includes('facebook')) {
      try {
        if (media.length === 1) {
          results.facebook = await graphRequest<{ id: string; post_id?: string }>('POST', `/${page.page_id}/photos`, page.page_access_token, { url: media[0], caption: message })
            .then((r) => ({ id: r.post_id ?? r.id }));
        } else if (media.length > 1) {
          const ids: string[] = [];
          for (const url of media) ids.push((await graphRequest<{ id: string }>('POST', `/${page.page_id}/photos`, page.page_access_token, { url, published: false })).id);
          results.facebook = await graphRequest<{ id: string }>('POST', `/${page.page_id}/feed`, page.page_access_token,
            { message, attached_media: ids.map((id) => ({ media_fbid: id })) });
        } else {
          results.facebook = await graphRequest<{ id: string }>('POST', `/${page.page_id}/feed`, page.page_access_token, { message, ...(link ? { link } : {}) });
        }
      } catch (error) {
        results.facebook = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (platforms.includes('instagram')) {
      const ig = page.instagram_business_account_id as string;
      const caption = link ? `${message}\n${link}` : message;
      try {
        let creation: string;
        if (media.length === 1) {
          creation = (await graphRequest<{ id: string }>('POST', `/${ig}/media`, page.page_access_token, { image_url: media[0], caption })).id;
        } else {
          const children: string[] = [];
          for (const url of media) children.push((await graphRequest<{ id: string }>('POST', `/${ig}/media`, page.page_access_token, { image_url: url, is_carousel_item: true })).id);
          creation = (await graphRequest<{ id: string }>('POST', `/${ig}/media`, page.page_access_token, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
        }
        results.instagram = await graphRequest<{ id: string }>('POST', `/${ig}/media_publish`, page.page_access_token, { creation_id: creation });
      } catch (error) {
        results.instagram = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const failed = Object.entries(results).filter(([, r]) => r.error);
    if (failed.length === platforms.length) {
      throw new BadRequestException(`Meta: ${failed.map(([p, r]) => `${p}: ${r.error}`).join(' | ')}`);
    }
    return results;
  }

  async editPost(user: AuthenticatedUser, postId: string, message: string) {
    const companyId = await this.adminCompany(user);
    const page = await this.page(companyId);
    if (!postId.startsWith(`${page.page_id}_`)) throw new BadRequestException('Only Facebook posts of your Page can be edited (Instagram does not allow editing through the API).');
    try {
      await graphRequest('POST', `/${postId}`, page.page_access_token, { message });
    } catch (error) {
      this.graphError(error);
    }
    return { id: postId, message };
  }

  async deletePost(user: AuthenticatedUser, postId: string) {
    const companyId = await this.adminCompany(user);
    const page = await this.page(companyId);
    if (!postId.startsWith(`${page.page_id}_`)) throw new BadRequestException('Only Facebook posts of your Page can be deleted (Instagram does not allow deleting through the API).');
    try {
      await graphRequest('DELETE', `/${postId}`, page.page_access_token);
    } catch (error) {
      this.graphError(error);
    }
    return { id: postId, deleted: true };
  }

  async schedules(user: AuthenticatedUser) {
    const companyId = await this.adminCompany(user);
    return this.dataSource.query(`SELECT * FROM social_post_schedule WHERE company_id = $1 ORDER BY scheduled_at DESC LIMIT 100`, [companyId]);
  }

  async cancelSchedule(user: AuthenticatedUser, id: number) {
    const companyId = await this.adminCompany(user);
    await this.dataSource.query(`UPDATE social_post_schedule SET status = 'cancelled' WHERE id = $1 AND company_id = $2 AND status = 'scheduled'`, [id, companyId]);
    return this.schedules(user);
  }

  /** Every minute: publish scheduled posts that are due. */
  async publishDue() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.dataSource.query(`
        UPDATE social_post_schedule SET status = 'publishing'
         WHERE id IN (SELECT id FROM social_post_schedule WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at LIMIT 10)
        RETURNING *`);
      const rows = Array.isArray(due[0]) ? due[0] : due;
      for (const row of rows) {
        try {
          const results = await this.publish(Number(row.company_id), row.platforms, row.message, row.link, row.media_urls ?? []);
          const partial = Object.values(results).some((r) => r.error);
          await this.dataSource.query(`UPDATE social_post_schedule SET status = $2, results = $3::jsonb, error = $4 WHERE id = $1`,
            [row.id, 'published', JSON.stringify(results), partial ? Object.entries(results).filter(([, r]) => r.error).map(([p, r]) => `${p}: ${r.error}`).join(' | ') : null]);
        } catch (error) {
          await this.dataSource.query(`UPDATE social_post_schedule SET status = 'failed', error = $2 WHERE id = $1`, [row.id, error instanceof Error ? error.message : String(error)]);
          await this.dataSource.query(`INSERT INTO bot_notification (company_id, kind, priority, title, message) VALUES ($1, 'social', 'HIGH', 'Scheduled post failed', $2)`,
            [row.company_id, (error instanceof Error ? error.message : String(error)).slice(0, 400)]).catch(() => undefined);
        }
      }
    } catch (error) {
      this.logger.warn(`scheduled posts: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /* ───────────────────────── analytics ───────────────────────── */

  /** Asks Meta for each metric on its own: Meta retires metrics now and then, one missing metric must not break the page. */
  private async series(id: string, token: string, metrics: string[], since: Date, until: Date, extra: Record<string, string> = {}) {
    const out: Record<string, Array<{ date: string; value: number }>> = {};
    for (const metric of metrics) {
      try {
        const r = await graphRequest<{ data: Array<{ name: string; values?: Array<{ value: unknown; end_time: string }> }> }>('GET', `/${id}/insights`, token, {
          metric, period: 'day', since: String(Math.floor(since.getTime() / 1000)), until: String(Math.floor(until.getTime() / 1000)), ...extra,
        });
        const values = r.data?.[0]?.values ?? [];
        if (values.length) out[metric] = values.map((v) => ({ date: v.end_time.slice(0, 10), value: typeof v.value === 'number' ? v.value : num(v.value) }));
      } catch {
        // metric not available for this Page / account – skipped
      }
    }
    return out;
  }

  async insights(user: AuthenticatedUser, daysRaw?: number) {
    const companyId = await this.adminCompany(user);
    const page = await this.page(companyId);
    const days = [7, 28, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 28;
    const until = new Date();
    const since = new Date(Date.now() - days * 86_400_000);
    // Meta returns at most ~90 days per request for page insights
    const facebook = await this.series(page.page_id, page.page_access_token,
      ['page_impressions_unique', 'page_impressions', 'page_post_engagements', 'page_views_total', 'page_daily_follows_unique', 'page_fan_adds_unique'], since, until);
    const instagram = page.instagram_business_account_id
      ? await this.series(page.instagram_business_account_id, page.page_access_token, ['reach', 'follower_count'], since > new Date(Date.now() - 29 * 86_400_000) ? since : new Date(Date.now() - 29 * 86_400_000), until)
      : {};
    const totals = async (metrics: string[]) => {
      if (!page.instagram_business_account_id) return {};
      const out: Record<string, number> = {};
      for (const metric of metrics) {
        try {
          const r = await graphRequest<{ data: Array<{ total_value?: { value?: number }; values?: Array<{ value: number }> }> }>(
            'GET', `/${page.instagram_business_account_id}/insights`, page.page_access_token,
            { metric, period: 'day', metric_type: 'total_value', since: String(Math.floor(since.getTime() / 1000)), until: String(Math.floor(until.getTime() / 1000)) });
          out[metric] = num(r.data?.[0]?.total_value?.value ?? r.data?.[0]?.values?.reduce((s, v) => s + num(v.value), 0));
        } catch {
          // not available
        }
      }
      return out;
    };
    const instagramTotals = await totals(['reach', 'profile_views', 'accounts_engaged', 'total_interactions', 'website_clicks']);
    const sum = (rows?: Array<{ value: number }>) => (rows ?? []).reduce((s, r) => s + num(r.value), 0);

    // per post + best time to post (from the last 50 posts of both platforms)
    const fbPosts = await this.posts(user, 'facebook').catch(() => ({ posts: [] as Array<Record<string, any>> }));
    const igPosts = page.instagram_business_account_id ? await this.posts(user, 'instagram').catch(() => ({ posts: [] as Array<Record<string, any>> })) : { posts: [] as Array<Record<string, any>> };
    const allPosts = [...(fbPosts?.posts ?? []), ...(igPosts?.posts ?? [])] as Array<Record<string, any>>;
    const engagement = (p: Record<string, any>) => num(p.likes) + num(p.comments) * 2 + num(p.shares) * 3;
    const slots = new Map<string, { total: number; posts: number }>();
    for (const p of allPosts) {
      const d = new Date(p.created_time);
      if (Number.isNaN(d.getTime())) continue;
      // Sri Lanka time (UTC+5:30)
      const local = new Date(d.getTime() + 330 * 60_000);
      const key = `${local.getUTCDay()}-${local.getUTCHours()}`;
      const slot = slots.get(key) ?? { total: 0, posts: 0 };
      slot.total += engagement(p);
      slot.posts += 1;
      slots.set(key, slot);
    }
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const bestTimes = [...slots.entries()]
      .map(([key, s]) => ({ day: weekdays[Number(key.split('-')[0])], hour: Number(key.split('-')[1]), average_engagement: Math.round((s.total / s.posts) * 10) / 10, posts: s.posts }))
      .sort((a, b) => b.average_engagement - a.average_engagement).slice(0, 5);

    const [comments] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
             COUNT(*) FILTER (WHERE replied_by_ai)::int AS replied_by_ai,
             COUNT(*) FILTER (WHERE private_replied_at IS NOT NULL)::int AS private_replies,
             COUNT(*) FILTER (WHERE status = 'open')::int AS open,
             COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (replied_at - created_time)) / 60) FILTER (WHERE replied_at IS NOT NULL)), 0)::int AS avg_response_minutes
        FROM social_comment WHERE company_id = $1 AND created_time > NOW() - make_interval(days => $2::int)`, [companyId, days]);
    const [chats] = await this.dataSource.query(`
      SELECT COUNT(DISTINCT cu.id)::int AS chats
        FROM social_comment sc JOIN bot_channel_user cu ON cu.company_id = sc.company_id AND cu.external_user_id = sc.author_id
       WHERE sc.company_id = $1 AND sc.private_replied_at IS NOT NULL AND sc.created_time > NOW() - make_interval(days => $2::int)`, [companyId, days]).catch(() => [{ chats: 0 }]);

    return {
      days,
      facebook: {
        series: facebook,
        totals: {
          reach: sum(facebook.page_impressions_unique), impressions: sum(facebook.page_impressions), engagement: sum(facebook.page_post_engagements),
          page_views: sum(facebook.page_views_total), new_followers: sum(facebook.page_daily_follows_unique ?? facebook.page_fan_adds_unique),
        },
        available: Object.keys(facebook),
      },
      instagram: { series: instagram, totals: instagramTotals, linked: Boolean(page.instagram_business_account_id) },
      top_posts: [...allPosts].sort((a, b) => engagement(b) - engagement(a)).slice(0, 5),
      best_times: bestTimes,
      comments: { ...comments, chats_from_comments: num(chats?.chats) },
    };
  }
}
