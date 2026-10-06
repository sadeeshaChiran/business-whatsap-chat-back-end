import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NotificationsQueryDto } from './dto/notifications-query.dto';

type NotificationType = 'REMINDER' | 'RISK' | 'INFO';
type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH';
type RelatedEntityType = 'order' | 'conversation' | 'queue' | null;

export type NotificationItem = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  is_read: boolean;
  priority: NotificationPriority;
  related_entity_type: RelatedEntityType;
  related_entity_id: number | null;
  created_at: string;
  updated_at: string;
};

const FEED_CACHE_MS = 20_000;

/**
 * Bell notifications:
 *  • sales bot alerts (special notes, order changes, cancellation requests) – last 14 days
 *  • admin: chats waiting in the unassigned queue
 *  • agent: chats assigned to me that wait for "Accept"
 * Read state is stored per user in user_notification_read.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly feedCache = new Map<number, { expiresAt: number; items: NotificationItem[] }>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getNotifications(user: AuthenticatedUser, query: NotificationsQueryDto) {
    const items = await this.feed(user);
    const readIds = await this.readKeys(user.id, items.map((item) => item.id));
    let result = items.map((item) => ({ ...item, is_read: readIds.has(item.id) }));
    if (query.unread === 'true') result = result.filter((item) => !item.is_read);
    if (query.type) result = result.filter((item) => item.type === query.type);
    return result;
  }

  /** Rebuild now (bell "refresh"). */
  async generateNotifications(user: AuthenticatedUser) {
    this.feedCache.delete(user.id);
    return this.getNotifications(user, {});
  }

  async markAsRead(user: AuthenticatedUser, notificationId: string) {
    const key = String(notificationId).slice(0, 80);
    await this.dataSource.query(
      `INSERT INTO user_notification_read (user_id, notification_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, key],
    );
    return { id: key, is_read: true };
  }

  async markAllAsRead(user: AuthenticatedUser) {
    const items = await this.feed(user);
    if (items.length) {
      await this.dataSource.query(
        `INSERT INTO user_notification_read (user_id, notification_key)
         SELECT $1, UNNEST($2::varchar[]) ON CONFLICT DO NOTHING`,
        [user.id, items.map((item) => item.id)],
      );
    }
    return { marked: items.length };
  }

  private async readKeys(userId: number, keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const rows: Array<{ notification_key: string }> = await this.dataSource.query(
      `SELECT notification_key FROM user_notification_read WHERE user_id = $1 AND notification_key = ANY($2::varchar[])`,
      [userId, keys],
    );
    return new Set(rows.map((row) => row.notification_key));
  }

  private async feed(user: AuthenticatedUser): Promise<NotificationItem[]> {
    const cached = this.feedCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const [botAlerts, workload] = await Promise.all([
      this.salesBotNotifications(user),
      user.role === 'admin' ? this.queueNotification(user) : this.agentPendingNotification(user),
    ]);
    const items = [...workload, ...botAlerts]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 30);
    if (this.feedCache.size > 2000) this.feedCache.clear();
    this.feedCache.set(user.id, { expiresAt: Date.now() + FEED_CACHE_MS, items });
    return items;
  }

  /** Sales bot alerts. Agents only see alerts for chats assigned to them. */
  private async salesBotNotifications(user: AuthenticatedUser): Promise<NotificationItem[]> {
    try {
      const rows: Array<{
        id: number; priority: NotificationPriority; title: string; message: string;
        conversation_id: number | null; order_id: number | null; created_at: Date;
      }> = user.role === 'admin'
        ? await this.dataSource.query(
            `SELECT id, priority, title, message, conversation_id, order_id, created_at
               FROM bot_notification
              WHERE company_id = $1 AND created_at > NOW() - INTERVAL '14 days'
              ORDER BY id DESC LIMIT 20`,
            [user.company_id],
          )
        : await this.dataSource.query(
            `SELECT n.id, n.priority, n.title, n.message, n.conversation_id, n.order_id, n.created_at
               FROM bot_notification n
               JOIN bot_conversation c ON c.id = n.conversation_id
              WHERE n.company_id = $1 AND c.assigned_agent_id = $2 AND n.created_at > NOW() - INTERVAL '14 days'
              ORDER BY n.id DESC LIMIT 20`,
            [user.company_id, user.id],
          );
      return rows.map((row) =>
        this.item({
          id: `sales-bot-${row.id}`,
          type: row.priority === 'HIGH' ? 'RISK' : 'INFO',
          title: row.title,
          message: row.message,
          priority: row.priority ?? 'MEDIUM',
          createdAt: new Date(row.created_at),
          relatedEntityType: row.order_id ? 'order' : row.conversation_id ? 'conversation' : null,
          relatedEntityId: row.order_id ?? row.conversation_id ?? null,
        }),
      );
    } catch (error) {
      this.logger.warn(`sales bot notifications skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async queueNotification(user: AuthenticatedUser): Promise<NotificationItem[]> {
    try {
      const [row] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS waiting, MIN(c.updated_at) AS oldest
           FROM bot_conversation c
           JOIN bot_channel_user u ON u.id = c.bot_channel_user_id
           JOIN companies co ON co.id = u.company_id
          WHERE u.company_id = $1
            AND LOWER(c.status) NOT IN ('active', 'closed')
            AND (c.assigned_agent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM app_user a
                   WHERE a.id = c.assigned_agent_id AND a.company_id = u.company_id
                     AND COALESCE(a.is_agent_active, FALSE) = TRUE
                     AND (co.admin_user_id IS NULL OR a.id <> co.admin_user_id)))`,
        [user.company_id],
      );
      const waiting = Number(row?.waiting ?? 0);
      if (!waiting) return [];
      const day = new Date().toISOString().slice(0, 13);
      return [
        this.item({
          id: `queue-${day}-${waiting}`,
          type: 'REMINDER',
          title: waiting === 1 ? '1 chat is waiting for an agent' : `${waiting} chats are waiting for an agent`,
          message: 'Open the Chat queue to assign them, or set an agent online.',
          priority: waiting >= 5 ? 'HIGH' : 'MEDIUM',
          createdAt: row?.oldest ? new Date(row.oldest) : new Date(),
          relatedEntityType: 'queue',
        }),
      ];
    } catch {
      return [];
    }
  }

  private async agentPendingNotification(user: AuthenticatedUser): Promise<NotificationItem[]> {
    try {
      const [row] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS pending, MIN(c.updated_at) AS oldest
           FROM bot_conversation c WHERE c.assigned_agent_id = $1 AND c.status = 'pending'`,
        [user.id],
      );
      const pending = Number(row?.pending ?? 0);
      if (!pending) return [];
      const day = new Date().toISOString().slice(0, 13);
      return [
        this.item({
          id: `pending-${user.id}-${day}-${pending}`,
          type: 'REMINDER',
          title: pending === 1 ? '1 new chat is waiting for you' : `${pending} new chats are waiting for you`,
          message: 'Open My chats and accept them so customers get a quick reply.',
          priority: 'HIGH',
          createdAt: row?.oldest ? new Date(row.oldest) : new Date(),
          relatedEntityType: 'conversation',
        }),
      ];
    } catch {
      return [];
    }
  }

  private item(params: {
    id: string; type: NotificationType; title: string; message: string; priority: NotificationPriority;
    createdAt: Date; relatedEntityType?: RelatedEntityType; relatedEntityId?: number | null;
  }): NotificationItem {
    const createdAt = (Number.isNaN(params.createdAt.getTime()) ? new Date() : params.createdAt).toISOString();
    return {
      id: params.id,
      type: params.type,
      title: params.title,
      message: params.message,
      is_read: false,
      priority: params.priority,
      related_entity_type: params.relatedEntityType ?? null,
      related_entity_id: params.relatedEntityId ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    };
  }
}
