/**
 * When to follow up a customer who showed interest but stopped replying.
 *
 * - Follow-up 1: FIRST hours after the customer's last message (default 3 h).
 * - Follow-up 2: SECOND hours after it (default 22 h) – still inside WhatsApp's 24-hour window, where
 *   normal messages are free and allowed. After 23 h we never send (a paid template would be needed).
 * - Only between 9:00 and 20:30 Sri Lanka time. A time at night moves to 9:00 the next morning, or back to
 *   20:30 the evening before when the morning is too late for the 24-hour window.
 * - At least 1 hour between two follow-ups.
 */
export const FOLLOWUP_WINDOW_HOURS = 23;
const DAY_START = 9 * 60;        // 09:00 (minutes after midnight, Sri Lanka)
const DAY_END = 20 * 60 + 30;    // 20:30
const SL_OFFSET_MIN = 330;       // UTC+5:30, no daylight saving
const HOUR = 3_600_000;

/** minutes after midnight in Sri Lanka */
function slMinutes(date: Date): number {
  return Math.floor(((date.getTime() / 60_000 + SL_OFFSET_MIN) % 1440 + 1440) % 1440);
}

/** the same Sri Lanka day at hh:mm */
function slDayAt(date: Date, minutes: number): Date {
  return new Date(date.getTime() - slMinutes(date) * 60_000 + minutes * 60_000 - (date.getTime() % 60_000));
}

export function isDaytime(date: Date): boolean {
  const m = slMinutes(date);
  return m >= DAY_START && m <= DAY_END;
}

/** The time for follow-up `number` (1 or 2), or null when there is no good time left. */
export function planFollowUp(options: {
  quietSince: Date; number: 1 | 2; firstHours: number; secondHours: number; now: Date; lastSentAt?: Date | null;
}): Date | null {
  const { quietSince, number, firstHours, secondHours, now, lastSentAt } = options;
  const hours = number === 1 ? firstHours : secondHours;
  if (!(hours > 0)) return null;
  const windowEnd = new Date(quietSince.getTime() + FOLLOWUP_WINDOW_HOURS * HOUR);
  const notBefore = new Date(Math.max(now.getTime(), lastSentAt ? lastSentAt.getTime() + HOUR : 0));
  let at = new Date(Math.max(quietSince.getTime() + hours * HOUR, notBefore.getTime()));
  if (!isDaytime(at)) {
    // forward to 9:00 (today if before 9, else tomorrow)
    const morning = slMinutes(at) < DAY_START ? slDayAt(at, DAY_START) : new Date(slDayAt(at, DAY_START).getTime() + 24 * HOUR);
    at = morning;
  }
  if (at > windowEnd) {
    // too late for the 24-hour window: the last good evening time before it
    let evening = slMinutes(windowEnd) >= DAY_START ? slDayAt(windowEnd, Math.min(DAY_END, slMinutes(windowEnd))) : new Date(slDayAt(windowEnd, DAY_END).getTime() - 24 * HOUR);
    if (evening > windowEnd) evening = windowEnd;
    if (evening < notBefore || !isDaytime(evening)) return null;
    at = evening;
  }
  return at;
}
