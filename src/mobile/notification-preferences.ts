import { Body, Controller, Get, Injectable, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';
import { DataSource } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

export type MessageMode = 'all' | 'attention' | 'off';
export type NotifyCategory = 'message' | 'orders' | 'order_changes' | 'handoffs' | 'bookings' | 'stock' | 'other';

export type NotificationPreference = {
  messages: MessageMode;
  orders: boolean;
  order_changes: boolean;
  handoffs: boolean;
  bookings: boolean;
  stock: boolean;
  quiet_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
};

export const DEFAULT_PREFERENCE: NotificationPreference = {
  messages: 'all', orders: true, order_changes: true, handoffs: true, bookings: true, stock: true,
  quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00',
};

/** Which switch a bot_notification kind belongs to. */
export function categoryOfKind(kind: string | null | undefined): NotifyCategory {
  switch (String(kind ?? '')) {
    case 'new_order': return 'orders';
    case 'order_changed': case 'change_request': case 'order_cancelled': case 'cancel_request': case 'special_note': return 'order_changes';
    case 'handoff': return 'handoffs';
    case 'booking_changed': case 'booking_cancelled': case 'new_booking': return 'bookings';
    case 'low_stock': case 'out_of_stock': return 'stock';
    default: return 'other';
  }
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** Sri Lanka clock (UTC+5:30, no daylight saving) in minutes after midnight. */
export function sriLankaMinutes(now = new Date()): number {
  return Math.floor(((now.getTime() / 60000) + 330) % 1440);
}

export function inQuietHours(pref: NotificationPreference, now = new Date()): boolean {
  if (!pref.quiet_enabled) return false;
  const t = sriLankaMinutes(now);
  const start = minutes(pref.quiet_start);
  const end = minutes(pref.quiet_end);
  return start === end ? false : start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * Should this person get a phone / browser notification?
 * urgent = a chat that needs a person (the bot handed over, or the chat is assigned to them): it still rings in quiet hours.
 */
export function wantsNotification(pref: NotificationPreference, category: NotifyCategory, opts: { urgent?: boolean; now?: Date } = {}): boolean {
  const urgent = Boolean(opts.urgent);
  let wanted: boolean;
  switch (category) {
    case 'message': wanted = pref.messages === 'all' || (pref.messages === 'attention' && urgent); break;
    case 'orders': wanted = pref.orders; break;
    case 'order_changes': wanted = pref.order_changes; break;
    case 'handoffs': wanted = pref.handoffs; break;
    case 'bookings': wanted = pref.bookings; break;
    case 'stock': wanted = pref.stock; break;
    default: wanted = true;
  }
  if (!wanted) return false;
  if (inQuietHours(pref, opts.now)) return urgent || category === 'handoffs';
  return true;
}

export class NotificationPreferenceDto {
  @IsOptional() @IsIn(['all', 'attention', 'off']) messages?: MessageMode;
  @IsOptional() @IsBoolean() orders?: boolean;
  @IsOptional() @IsBoolean() order_changes?: boolean;
  @IsOptional() @IsBoolean() handoffs?: boolean;
  @IsOptional() @IsBoolean() bookings?: boolean;
  @IsOptional() @IsBoolean() stock?: boolean;
  @IsOptional() @IsBoolean() quiet_enabled?: boolean;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quiet_start?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) quiet_end?: string;
}

const COLUMNS = ['messages', 'orders', 'order_changes', 'handoffs', 'bookings', 'stock', 'quiet_enabled', 'quiet_start', 'quiet_end'] as const;

@Injectable()
export class NotificationPreferencesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private shape(row: Record<string, unknown> | undefined): NotificationPreference {
    if (!row) return { ...DEFAULT_PREFERENCE };
    return {
      messages: (['all', 'attention', 'off'].includes(String(row.messages)) ? row.messages : 'all') as MessageMode,
      orders: row.orders !== false, order_changes: row.order_changes !== false, handoffs: row.handoffs !== false,
      bookings: row.bookings !== false, stock: row.stock !== false, quiet_enabled: row.quiet_enabled === true,
      quiet_start: String(row.quiet_start ?? '22:00'), quiet_end: String(row.quiet_end ?? '07:00'),
    };
  }

  async get(user: AuthenticatedUser) {
    const [row] = await this.dataSource.query(`SELECT * FROM notification_preference WHERE user_id = $1`, [user.id]);
    return { ...this.shape(row), saved: Boolean(row) };
  }

  async save(user: AuthenticatedUser, dto: NotificationPreferenceDto) {
    const next = { ...(await this.get(user)), ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as NotificationPreference;
    await this.dataSource.query(
      `INSERT INTO notification_preference (user_id, company_id, ${COLUMNS.join(', ')}, updated_at)
       VALUES ($1, $2, ${COLUMNS.map((_, i) => `$${i + 3}`).join(', ')}, NOW())
       ON CONFLICT (user_id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, company_id = EXCLUDED.company_id, updated_at = NOW()`,
      [user.id, user.company_id, ...COLUMNS.map((c) => next[c])]);
    // keep the browser's own setting in step (older app versions read it)
    await this.dataSource.query(`UPDATE web_push_subscription SET mode = $2 WHERE user_id = $1`, [user.id, next.messages === 'all' ? 'all' : 'attention']).catch(() => undefined);
    return this.get(user);
  }

  /** The people (of these) who want this notification now. People without settings get everything, as before. */
  async filter(userIds: number[], category: NotifyCategory, opts: { urgent?: boolean; now?: Date } = {}): Promise<number[]> {
    const ids = [...new Set(userIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return [];
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT * FROM notification_preference WHERE user_id = ANY($1::bigint[])`, [ids]).catch(() => []);
    const byUser = new Map(rows.map((row) => [Number(row.user_id), this.shape(row)]));
    return ids.filter((id) => {
      const pref = byUser.get(id);
      return pref ? wantsNotification(pref, category, opts) : true;
    });
  }

  /** Users that have saved settings (their browser "mode" is replaced by these settings). */
  async withSettings(userIds: number[]): Promise<Set<number>> {
    if (!userIds.length) return new Set();
    const rows: Array<{ user_id: string }> = await this.dataSource.query(`SELECT user_id FROM notification_preference WHERE user_id = ANY($1::bigint[])`, [userIds]).catch(() => []);
    return new Set(rows.map((row) => Number(row.user_id)));
  }
}

@Controller('notifications/preferences')
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) { return this.preferences.get(user); }

  @Put()
  save(@CurrentUser() user: AuthenticatedUser, @Body() dto: NotificationPreferenceDto) { return this.preferences.save(user, dto); }
}
