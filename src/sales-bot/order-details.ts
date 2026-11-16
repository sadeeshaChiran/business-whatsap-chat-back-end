/**
 * The shop's own order details form. Every shop asks for other details ("Name / Address / Two phone numbers /
 * Nearest city", or "Full Name / Address / Mobile Number 1 / Nearby City / District / Size"). When the shop's training
 * has such a form, the AI fills it from the customer's answer (order.details = [{label, value}] with the shop's own
 * labels) and it is written into the order note, neatly, so the team can pack and ship without reading the chat.
 * A shop without its own form: no details, no note (the normal order fields are enough).
 */
export type OrderDetail = { label: string; value: string };

const clean = (text: unknown, max: number) => String(text ?? '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Only real label/value pairs (max 12); the labels without markdown, emojis or a trailing ":". */
export function cleanOrderDetails(raw: unknown): OrderDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: OrderDetail[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const label = clean((row as { label?: unknown }).label, 60).replace(/^[-•\s]+/, '').replace(/[\p{Extended_Pictographic}️]/gu, '').replace(/[:\s]+$/, '').trim();
    const value = clean((row as { value?: unknown }).value, 300);
    if (!label || !value || out.some((d) => d.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, value });
    if (out.length >= 12) break;
  }
  return out;
}

/** The new answers win; a field the customer did not repeat keeps its earlier value (order of the first form kept). */
export function mergeOrderDetails(previous: OrderDetail[] | undefined, next: OrderDetail[]): OrderDetail[] {
  const merged = [...(previous ?? [])];
  for (const detail of next) {
    const at = merged.findIndex((d) => d.label.toLowerCase() === detail.label.toLowerCase());
    if (at >= 0) merged[at] = detail; else merged.push(detail);
  }
  return merged.slice(0, 12);
}

/** The block written into the order note. */
export function orderDetailsNote(details: OrderDetail[] | undefined): string {
  if (!details?.length) return '';
  return ['📋 Customer details:', ...details.map((d) => `${d.label}: ${d.value}`)].join('\n');
}
