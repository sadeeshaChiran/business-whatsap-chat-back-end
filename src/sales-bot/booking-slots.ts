/**
 * Booking time checks: does a new booking (date + time + service duration) overlap bookings that already
 * hold that time? Which statuses hold a time is a shop setting:
 *   'requested' (default) - requested AND confirmed bookings hold the time
 *   'confirmed'           - only confirmed bookings hold it (a requested time can still be given to someone else)
 * capacity = how many bookings may run at the same time (staff / chairs), default 1.
 */
export type BookingBlockMode = 'requested' | 'confirmed';
export const BOOKING_BLOCK_MODES: BookingBlockMode[] = ['requested', 'confirmed'];
export const DEFAULT_BOOKING_MINUTES = 60;

export function blockingStatuses(mode: string | null | undefined): string[] {
  return mode === 'confirmed' ? ['confirmed'] : ['requested', 'confirmed'];
}

/** "2026-10-12", "2026/10/12", "12/10/2026", "12-10-2026" -> "2026-10-12" (null = not a clear date) */
export function normalizeBookingDate(value: unknown): string | null {
  const text = String(value ?? '').trim();
  let y: number, m: number, d: number;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "14:30", "2.30 pm", "10am", "9", "09:00" -> minutes after midnight (null = not a clear time) */
export function bookingMinutes(value: unknown): number | null {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const match = text.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3]?.replace(/\./g, '');
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === 'pm' && hour !== 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return hour * 60 + minute;
}

export function formatMinutes(total: number): string {
  const minutes = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export type BusyRange = { start: number; end: number; id?: number };

/** Most bookings running at the same moment inside [start, end). */
export function peakOverlap(busy: BusyRange[], start: number, end: number): number {
  const inside = busy.filter((range) => range.start < end && range.end > start);
  const points = [start, ...inside.map((range) => range.start).filter((point) => point > start && point < end)];
  return points.reduce((peak, point) => Math.max(peak, inside.filter((range) => range.start <= point && range.end > point).length), 0);
}

export function isFree(busy: BusyRange[], start: number, end: number, capacity = 1): boolean {
  return peakOverlap(busy, start, end) < Math.max(1, capacity);
}

/** "9am - 6pm", "09:00-18:00", "Mon-Sat 8.30 am to 5 pm" -> first open/close pair (default 08:00-20:00). */
export function openingWindow(text: string | null | undefined): { open: number; close: number } {
  const match = String(text ?? '').toLowerCase().match(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|to|until|till)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/);
  if (match) {
    const open = bookingMinutes(match[1]);
    let close = bookingMinutes(match[2]);
    if (open != null && close != null) {
      if (close <= open && close < 12 * 60) close += 12 * 60; // "9 - 6" means 9am to 6pm
      if (close > open) return { open, close };
    }
  }
  return { open: 8 * 60, close: 20 * 60 };
}

/** Up to `limit` free start times on the same day inside the opening hours, nearest to the wanted time first (30-minute steps). */
export function nearestFreeTimes(busy: BusyRange[], wanted: number, duration: number, capacity = 1, limit = 3,
  window: { open: number; close: number } = { open: 8 * 60, close: 20 * 60 }): string[] {
  const options: number[] = [];
  for (let start = window.open; start + duration <= window.close; start += 30) {
    if (start !== wanted && isFree(busy, start, start + duration, capacity)) options.push(start);
  }
  return options.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b).slice(0, limit).sort((a, b) => a - b).map(formatMinutes);
}

/** Saved bookings of one day -> busy ranges (rows with an unclear time are ignored). */
export function busyRanges(
  rows: Array<{ id?: number; time: string | null; service_id: number | null }>,
  durationOf: (serviceId: number | null) => number,
): BusyRange[] {
  return rows.flatMap((row) => {
    const start = bookingMinutes(row.time);
    return start == null ? [] : [{ id: row.id, start, end: start + durationOf(row.service_id) }];
  });
}

const TAKEN: Record<string, (time: string, booked: string, free: string) => string> = {
  sinhala: (time, booked, free) => `සමාවෙන්න, ${time} වෙලාව දැනටමත් වෙන් කරලා.${booked}${free ? ` නිදහස් වෙලාවන්: ${free}. ඔයාට ගැලපෙන වෙලාවක් කියන්න.` : ' වෙන දවසක් හෝ වෙලාවක් කියන්න.'}`,
  sinhala_latin: (time, booked, free) => `Sorry, ${time} welawa dan book karala thiyenne.${booked}${free ? ` Free welawal: ${free}. Oyata hari welawak kiyanna.` : ' Wena dawasak hari welawak kiyanna.'}`,
  tamil: (time, booked, free) => `மன்னிக்கவும், ${time} நேரம் ஏற்கனவே பதிவு செய்யப்பட்டுள்ளது.${booked}${free ? ` கிடைக்கும் நேரங்கள்: ${free}. உங்களுக்கு ஏற்ற நேரத்தை சொல்லுங்கள்.` : ' வேறு நாள் அல்லது நேரத்தை சொல்லுங்கள்.'}`,
  english: (time, booked, free) => `Sorry, ${time} is already booked.${booked}${free ? ` Free times: ${free}. Which one suits you?` : ' Please tell me another day or time.'}`,
};

/** The message when the wanted time is taken (in the chat's language). */
export function slotTakenMessage(language: string | null | undefined, date: string, wanted: number, free: string[]): string {
  const make = TAKEN[language ?? ''] ?? TAKEN.english;
  return make(`${date} ${formatMinutes(wanted)}`, '', free.join(', '));
}
