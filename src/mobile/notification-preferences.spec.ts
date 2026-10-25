import { DEFAULT_PREFERENCE, categoryOfKind, inQuietHours, wantsNotification } from './notification-preferences';

/** Who gets a phone / browser notification, from their own settings. */
describe('notification settings', () => {
  // 2026-10-25 23:30 in Sri Lanka = 18:00 UTC; 15:00 Sri Lanka = 09:30 UTC
  const night = new Date('2026-10-25T18:00:00Z');
  const day = new Date('2026-10-25T09:30:00Z');

  it('maps alert kinds to the switches', () => {
    expect(categoryOfKind('new_order')).toBe('orders');
    expect(categoryOfKind('cancel_request')).toBe('order_changes');
    expect(categoryOfKind('handoff')).toBe('handoffs');
    expect(categoryOfKind('booking_cancelled')).toBe('bookings');
    expect(categoryOfKind('low_stock')).toBe('stock');
    expect(categoryOfKind('something_new')).toBe('other');
  });

  it('messages: every message, only chats that need a person, or none', () => {
    expect(wantsNotification({ ...DEFAULT_PREFERENCE, messages: 'all' }, 'message', { now: day })).toBe(true);
    expect(wantsNotification({ ...DEFAULT_PREFERENCE, messages: 'attention' }, 'message', { now: day })).toBe(false);
    expect(wantsNotification({ ...DEFAULT_PREFERENCE, messages: 'attention' }, 'message', { urgent: true, now: day })).toBe(true);
    expect(wantsNotification({ ...DEFAULT_PREFERENCE, messages: 'off' }, 'message', { urgent: true, now: day })).toBe(false);
  });

  it('orders only', () => {
    const ordersOnly = { ...DEFAULT_PREFERENCE, messages: 'off' as const, order_changes: false, bookings: false, stock: false };
    expect(wantsNotification(ordersOnly, 'orders', { now: day })).toBe(true);
    expect(wantsNotification(ordersOnly, 'order_changes', { now: day })).toBe(false);
    expect(wantsNotification(ordersOnly, 'stock', { now: day })).toBe(false);
  });

  it('quiet hours keep only chats that need a person', () => {
    const quiet = { ...DEFAULT_PREFERENCE, quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00' };
    expect(inQuietHours(quiet, night)).toBe(true);
    expect(inQuietHours(quiet, day)).toBe(false);
    expect(wantsNotification(quiet, 'orders', { now: night })).toBe(false);
    expect(wantsNotification(quiet, 'message', { now: night })).toBe(false);
    expect(wantsNotification(quiet, 'message', { urgent: true, now: night })).toBe(true);
    expect(wantsNotification(quiet, 'handoffs', { now: night })).toBe(true);
    expect(wantsNotification(quiet, 'orders', { now: day })).toBe(true);
  });
});
