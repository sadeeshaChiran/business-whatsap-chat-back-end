import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { publicChatMediaUrl, saveChatMedia } from '../bot-admin/chat-media.store';
import { PusherService } from '../common/pusher.service';
import { CustomerAppService } from './customer-app.service';
import type { CustomerAccount } from './customer-auth';
import { CONTACT_PHONES_SQL } from './customer-members.service';
import { CustomerPushService } from './customer-push.service';

type Row = Record<string, any>;
type Upload = { buffer: Buffer; mimetype: string; originalname: string };
export type BroadcastAudience = { all?: boolean; tags?: string[]; group_ids?: number[] };

const MAX_TEXT = 4000;

/**
 * Broadcasts in the customer app: one message (offer, notice, reminder) from the business into the app chat of many customers
 * at once – free, no limits, no approval. Only numbers on the business's app list get it; people who don't have the app yet are
 * counted (so the business can invite them). Customers who said "stop" to marketing are skipped. A phone notification goes with it.
 * The message also shows in each customer's inbox chat (without moving that chat up the list).
 */
@Injectable()
export class CustomerBroadcastService implements OnModuleInit {
  private readonly logger = new Logger(CustomerBroadcastService.name);
  private readonly pusher = new PusherService();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly app: CustomerAppService,
    private readonly push: CustomerPushService,
  ) {}

  onModuleInit() {
    void this.dataSource.query(`
      UPDATE ca_campaign SET status = 'cancelled', finished_at = NOW(),
             last_error = COALESCE(last_error, 'Stopped by a server restart – the people counted as sent got it; send a new one for the rest.')
       WHERE status = 'sending' AND created_at < NOW() - INTERVAL '1 minute'`).catch(() => undefined);
  }

  private clean(input: BroadcastAudience) {
    const tags = (Array.isArray(input.tags) ? input.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const groups = (Array.isArray(input.group_ids) ? input.group_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    const all = input.all === true || (!tags.length && !groups.length);
    return { all, tags, group_ids: groups };
  }

  /** Numbers on the app list that match the audience, with their app account (null = doesn't have the app yet). */
  private async targets(companyId: number, audience: ReturnType<CustomerBroadcastService['clean']>) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT am.phone, CASE WHEN am.joined_at IS NOT NULL THEN a.id END AS account_id
        FROM ca_app_member am LEFT JOIN ca_account a ON a.phone = am.phone
       WHERE am.company_id = $1
         AND ($2 OR am.phone IN (SELECT c.phone FROM (${CONTACT_PHONES_SQL}) c WHERE COALESCE(array_length($3::text[], 1), 0) > 0 AND c.tags && $3::text[])
              OR a.id IN (SELECT gm.account_id FROM ca_group_member gm JOIN ca_group g ON g.id = gm.group_id AND g.company_id = $1 AND g.archived_at IS NULL
                           WHERE gm.group_id = ANY($4::bigint[])))
         AND NOT EXISTS (SELECT 1 FROM bot_channel_user cu JOIN marketing_optout o ON o.company_id = $1 AND o.bot_channel_user_id = cu.id
                          WHERE cu.company_id = $1 AND cu.platform = 'app' AND cu.external_user_id = 'ca:' || a.id)`,
    [companyId, audience.all, audience.tags, audience.group_ids]);
    return { on_app: rows.filter((r) => r.account_id).map((r) => Number(r.account_id)), not_on_app: rows.filter((r) => !r.account_id).length };
  }

  async audience(companyId: number, input: BroadcastAudience) {
    const t = await this.targets(companyId, this.clean(input));
    return { on_app: t.on_app.length, not_on_app: t.not_on_app };
  }

  async list(companyId: number) {
    const rows: Row[] = await this.dataSource.query(`
      SELECT c.*, (SELECT COUNT(*)::int FROM ca_campaign_recipient r JOIN ca_chat_state st ON st.channel_user_id = r.channel_user_id
                     WHERE r.campaign_id = c.id AND r.sent_at IS NOT NULL AND st.last_read_at >= r.sent_at) AS read
        FROM ca_campaign c WHERE c.company_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [companyId]);
    return rows.map((r) => ({
      id: Number(r.id), text: r.text, image_url: r.media_key ? publicChatMediaUrl(r.media_key, 6 * 3600) : null, audience: r.audience, status: r.status,
      total: Number(r.total), sent: Number(r.sent), read: Number(r.read ?? 0), not_on_app: Number(r.not_on_app), last_error: r.last_error, created_at: r.created_at, finished_at: r.finished_at,
    }));
  }

  async create(companyId: number, userId: number, input: BroadcastAudience & { text?: string }, photo: Upload | null) {
    const [settings] = await this.dataSource.query(`SELECT enabled FROM ca_settings WHERE company_id = $1`, [companyId]);
    if (!settings?.enabled) throw new BadRequestException('Switch on the customer app first.');
    const text = String(input.text ?? '').trim();
    if (text.length > MAX_TEXT) throw new BadRequestException(`A message can have up to ${MAX_TEXT} characters.`);
    let mediaKey: string | null = null;
    if (photo?.buffer?.length) {
      const mime = String(photo.mimetype || '').split(';')[0].toLowerCase();
      if (!/^image\/(jpe?g|png|webp|gif)$/.test(mime)) throw new BadRequestException('Use a JPG, PNG, WEBP or GIF picture.');
      if (photo.buffer.length > 10 * 1024 * 1024) throw new BadRequestException('The picture must be smaller than 10 MB.');
      mediaKey = saveChatMedia(companyId, photo.buffer, mime, photo.originalname || 'broadcast.jpg');
    }
    if (!text && !mediaKey) throw new BadRequestException('Write the message or add a picture.');
    const audience = this.clean(input);
    const t = await this.targets(companyId, audience);
    if (!t.on_app.length) throw new BadRequestException(t.not_on_app ? `None of these ${t.not_on_app} people have the app yet – share your app link with them first.` : 'Nobody matches – add numbers to your app list first.');
    const [record] = await this.dataSource.query(`
      INSERT INTO ca_campaign (company_id, text, media_key, audience, status, total, not_on_app, created_by) VALUES ($1, $2, $3, $4::jsonb, 'sending', $5, $6, $7) RETURNING id`,
    [companyId, text, mediaKey, JSON.stringify(audience), t.on_app.length, t.not_on_app, userId]);
    const id = Number(record.id);
    void this.run(companyId, id, text, mediaKey, t.on_app).catch(async (error) => {
      this.logger.error(`app broadcast ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.dataSource.query(`UPDATE ca_campaign SET status = 'failed', last_error = $2, finished_at = NOW() WHERE id = $1`, [id, String(error).slice(0, 300)]).catch(() => undefined);
    });
    return { id, total: t.on_app.length, not_on_app: t.not_on_app };
  }

  private async run(companyId: number, id: number, text: string, mediaKey: string | null, accounts: number[]) {
    const [company] = await this.dataSource.query(`SELECT COALESCE(NULLIF(s.app_name, ''), c.company_name) AS name FROM companies c LEFT JOIN ca_settings s ON s.company_id = c.id WHERE c.id = $1`, [companyId]);
    const accountRows: Row[] = await this.dataSource.query(`SELECT * FROM ca_account WHERE id = ANY($1::bigint[])`, [accounts]);
    let sent = 0;
    const notified: number[] = [];
    for (const account of accountRows) {
      if (sent % 50 === 0) {
        const [state] = await this.dataSource.query(`SELECT status FROM ca_campaign WHERE id = $1`, [id]);
        if (state?.status === 'cancelled') break;
      }
      try {
        const customer: CustomerAccount = { id: Number(account.id), phone: String(account.phone), name: account.name ?? null, token_version: Number(account.token_version ?? 0) };
        const user = await this.app.channelUser(customer, companyId, true, { welcome: false });
        if (!user) continue;
        // the message goes into the latest chat; a customer without a chat gets a closed one (it does not open a chat in the Inbox)
        let [conversation] = await this.dataSource.query(`SELECT id FROM bot_conversation WHERE bot_channel_user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
        if (!conversation) {
          [conversation] = await this.dataSource.query(`
            INSERT INTO bot_conversation (bot_channel_user_id, status, assignment_mode, last_message_at, created_at, updated_at)
            VALUES ($1, 'closed', 'unassigned', NOW(), NOW(), NOW()) RETURNING id`, [user.id]);
        }
        const [message] = await this.dataSource.query(`
          INSERT INTO bot_message (conversation_id, direction, message_type, platform, provider_message_id, delivery_status, content, media_url, source, created_at, updated_at)
          VALUES ($1, 'outbound', $2, 'app', $3, 'sent', $4, $5, 'app-broadcast', NOW(), NOW()) RETURNING id, created_at`,
        [conversation.id, mediaKey ? 'image' : 'text', `app:bc${id}-${account.id}`, text || '[image]', mediaKey]);
        await this.dataSource.query(`
          INSERT INTO ca_campaign_recipient (campaign_id, account_id, channel_user_id, message_id, sent_at) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING`, [id, account.id, user.id, message.id, message.created_at]);
        sent += 1;
        notified.push(Number(account.id));
        this.app.pingCustomer(Number(account.id), companyId);
      } catch (error) {
        await this.dataSource.query(`UPDATE ca_campaign SET last_error = $2 WHERE id = $1`, [id, (error instanceof Error ? error.message : String(error)).slice(0, 300)]);
      }
      if (sent % 50 === 0) await this.dataSource.query(`UPDATE ca_campaign SET sent = $2 WHERE id = $1`, [id, sent]);
    }
    for (let i = 0; i < notified.length; i += 200) {
      this.push.notify(notified.slice(i, i + 200), companyId, {
        title: String(company?.name ?? 'Business'), body: text ? text.slice(0, 160) : '📷 Photo', target: { kind: 'chat' }, tag: `${companyId}:bc${id}`,
      });
    }
    await this.dataSource.query(`
      UPDATE ca_campaign SET sent = $2, status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'sent' END, finished_at = NOW() WHERE id = $1`, [id, sent]);
    this.pusher.trigger(`company-${companyId}`, 'conversation_updated', { platform: 'app', broadcast: id });
  }

  async cancel(companyId: number, id: number) {
    const [row] = await this.dataSource.query(`SELECT id FROM ca_campaign WHERE id = $1 AND company_id = $2`, [id, companyId]);
    if (!row) throw new NotFoundException('Broadcast not found.');
    await this.dataSource.query(`UPDATE ca_campaign SET status = 'cancelled' WHERE id = $1 AND status = 'sending'`, [id]);
    return { cancelled: true };
  }
}
