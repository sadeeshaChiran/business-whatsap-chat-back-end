import { bookingMinutes, busyRanges, isFree, nearestFreeTimes, normalizeBookingDate, openingWindow, peakOverlap, blockingStatuses, slotTakenMessage } from './booking-slots';

describe('booking slots', () => {
  it('reads dates and times the way customers and the bot write them', () => {
    expect(normalizeBookingDate('2026-10-12')).toBe('2026-10-12');
    expect(normalizeBookingDate('12/10/2026')).toBe('2026-10-12');
    expect(normalizeBookingDate('2026-02-30')).toBeNull();
    expect(normalizeBookingDate('tomorrow')).toBeNull();
    expect(bookingMinutes('14:30')).toBe(870);
    expect(bookingMinutes('2.30 pm')).toBe(870);
    expect(bookingMinutes('10am')).toBe(600);
    expect(bookingMinutes('12 am')).toBe(0);
    expect(bookingMinutes('evening')).toBeNull();
  });

  it('checks overlap with the service duration', () => {
    const busy = busyRanges([{ time: '10:00', service_id: 1 }, { time: 'after lunch', service_id: 1 }], () => 60);
    expect(busy).toHaveLength(1);
    expect(isFree(busy, 9 * 60, 10 * 60)).toBe(true); // 9-10 ends when 10-11 starts
    expect(isFree(busy, 10 * 60 + 30, 11 * 60 + 30)).toBe(false); // 10:30 overlaps 10-11
    expect(isFree(busy, 9 * 60 + 30, 10 * 60 + 30)).toBe(false); // 9:30 for 60 min runs into 10:00
    expect(isFree(busy, 11 * 60, 12 * 60)).toBe(true);
  });

  it('allows parallel bookings up to the capacity', () => {
    const busy = [{ start: 600, end: 660 }, { start: 630, end: 690 }];
    expect(peakOverlap(busy, 600, 690)).toBe(2);
    expect(isFree(busy, 600, 660, 2)).toBe(false);
    expect(isFree(busy, 660, 720, 2)).toBe(true); // only one runs after 11:00
    expect(isFree(busy, 600, 615, 3)).toBe(true);
  });

  it('suggests the nearest free times inside the opening hours', () => {
    const busy = [{ start: 600, end: 660 }];
    expect(nearestFreeTimes(busy, 600, 60, 1, 3, openingWindow('9am - 6pm'))).toEqual(['09:00', '11:00', '11:30']);
    expect(openingWindow('Mon-Sat 9 - 6')).toEqual({ open: 540, close: 1080 });
    expect(openingWindow('')).toEqual({ open: 480, close: 1200 });
  });

  it('knows which statuses hold a time', () => {
    expect(blockingStatuses(undefined)).toEqual(['requested', 'confirmed']);
    expect(blockingStatuses('confirmed')).toEqual(['confirmed']);
    expect(slotTakenMessage('english', '2026-10-12', 600, ['11:00'])).toContain('2026-10-12 10:00 is already booked');
  });
});
