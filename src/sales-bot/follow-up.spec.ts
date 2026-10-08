import { isDaytime, planFollowUp } from './follow-up';

/** Sri Lanka time (UTC+5:30) → Date */
const sl = (iso: string) => new Date(`${iso}:00+05:30`);
const plan = (quiet: string, number: 1 | 2, now = quiet, lastSent?: string) =>
  planFollowUp({ quietSince: sl(quiet), number, firstHours: 3, secondHours: 22, now: sl(now), lastSentAt: lastSent ? sl(lastSent) : null });

describe('follow-up times', () => {
  it('daytime: 3 hours and 22 hours after the last message', () => {
    expect(plan('2026-10-08T10:00', 1)).toEqual(sl('2026-10-08T13:00'));
    // 22 h after 10:00 = 08:00 next day (night) → 09:00, still inside 23 h? 10:00+23h = 09:00 → yes
    expect(plan('2026-10-08T10:00', 2, '2026-10-08T13:00', '2026-10-08T13:00')).toEqual(sl('2026-10-09T09:00'));
  });
  it('evening message: follow-up 1 moves to the next morning', () => {
    expect(plan('2026-10-08T19:00', 1)).toEqual(sl('2026-10-09T09:00'));
    // 22 h after 19:00 = 17:00 next day
    expect(plan('2026-10-08T19:00', 2, '2026-10-09T09:00', '2026-10-09T09:00')).toEqual(sl('2026-10-09T17:00'));
  });
  it('late night message: follow-ups next day, never after the 24-hour window', () => {
    expect(plan('2026-10-08T23:30', 1)).toEqual(sl('2026-10-09T09:00'));
    expect(plan('2026-10-08T23:30', 2, '2026-10-09T09:00', '2026-10-09T09:00')).toEqual(sl('2026-10-09T20:30'));
  });
  it('morning message: 22 h lands at night → back to the evening before the window ends', () => {
    // 07:00 + 22 h = 05:00 next day (night); the window ends 06:00 → last good time 20:30 on day 1
    expect(plan('2026-10-08T07:00', 2, '2026-10-08T10:00', '2026-10-08T10:00')).toEqual(sl('2026-10-08T20:30'));
  });
  it('no time left → null', () => {
    expect(plan('2026-10-08T07:00', 2, '2026-10-08T20:00', '2026-10-08T20:00')).toBeNull();
    expect(planFollowUp({ quietSince: sl('2026-10-08T10:00'), number: 2, firstHours: 3, secondHours: 0, now: sl('2026-10-08T13:00') })).toBeNull();
  });
  it('isDaytime uses Sri Lanka time', () => {
    expect(isDaytime(sl('2026-10-08T08:59'))).toBe(false);
    expect(isDaytime(sl('2026-10-08T09:00'))).toBe(true);
    expect(isDaytime(sl('2026-10-08T20:31'))).toBe(false);
  });
});
