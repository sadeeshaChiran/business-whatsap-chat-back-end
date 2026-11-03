/**
 * Pure rules for stock counting, demand tracking and the reorder-due list (no database – unit tested).
 */

export type StockOption = {
  variant_name?: string;
  variant_value?: string;
  quantity?: number;
  available?: boolean;
  auto_off?: boolean;
  [key: string]: unknown;
};

/** Label shown to customers for one variant option, e.g. "Red / M" (same rule as the sales bot). */
export function optionLabel(option: StockOption): string {
  const name = String(option.variant_name ?? '').trim();
  const value = String(option.variant_value ?? '').trim();
  if (!value) return name;
  if (!name || name === value || name.includes('/') || value.toLowerCase().startsWith(name.toLowerCase())) return value;
  return `${name}: ${value}`;
}

/** An option name as a sorted word set: "XL / White" = "white xl" ("Colour:" / "Size:" ignored). */
export function optionWords(text: string): string {
  return String(text ?? '').toLowerCase().replace(/\b(colou?r|size|pack|type|style)\s*:/g, ' ')
    .split(/[^a-z0-9඀-෿஀-௿.]+/).filter(Boolean).sort().join(' ');
}

/** Index of the option an order line means (its variant text), or -1. */
export function findOption(options: StockOption[], variantText: string | null | undefined): number {
  const wanted = String(variantText ?? '').trim().toLowerCase();
  if (!wanted) return -1;
  const exact = options.findIndex((o) => optionLabel(o).toLowerCase() === wanted || String(o.variant_value ?? '').trim().toLowerCase() === wanted);
  if (exact >= 0) return exact;
  const key = optionWords(wanted);
  return options.findIndex((o) => optionWords(optionLabel(o)) === key || optionWords(String(o.variant_value ?? '')) === key);
}

export const stockKey = (productId: number, label: string | null) => `${productId}|${label ?? ''}`;

/**
 * How much stock each (product, option) must move so the order holds exactly what it should:
 * desired = what the order needs now (0 when cancelled or deleted), held = what it took out before.
 * Returns the change to apply to the stock (negative = take out).
 */
export function stockChanges(desired: Map<string, number>, held: Map<string, number>): Array<{ key: string; change: number; desired: number; held: number }> {
  const keys = new Set([...desired.keys(), ...held.keys()]);
  const out: Array<{ key: string; change: number; desired: number; held: number }> = [];
  for (const key of keys) {
    const want = desired.get(key) ?? 0;
    const has = held.get(key) ?? 0;
    if (want !== has) out.push({ key, change: has - want, desired: want, held: has });
  }
  return out;
}

export type StockAlert = 'out_of_stock' | 'low_stock' | 'back_in_stock' | null;

/** The alert a stock change causes (only when it crosses a line, so the team is not told twice). */
export function stockAlert(before: number, after: number, lowLevel: number): StockAlert {
  if (after <= 0 && before > 0) return 'out_of_stock';
  if (after > 0 && before <= 0) return 'back_in_stock';
  if (lowLevel > 0 && after > 0 && after <= lowLevel && before > lowLevel) return 'low_stock';
  return null;
}

/** Stock state for lists and badges. */
export function stockState(stock: number, lowLevel: number): 'out' | 'low' | 'ok' {
  if (stock <= 0) return 'out';
  if (lowLevel > 0 && stock <= lowLevel) return 'low';
  return 'ok';
}

/** Total stock and state of a product; a product with options is "low" / "out" when any option is. */
export function productStock(hasVariants: boolean, options: unknown, quantity: unknown, lowLevel: number): { stock: number; state: 'out' | 'low' | 'ok' } {
  const list = hasVariants && Array.isArray(options) ? (options as Array<{ quantity?: unknown }>) : [];
  if (!list.length) {
    const stock = Number(quantity) || 0;
    return { stock, state: stockState(stock, lowLevel) };
  }
  const states = list.map((o) => stockState(Number(o.quantity) || 0, lowLevel));
  return {
    stock: list.reduce((sum, o) => sum + Math.max(0, Number(o.quantity) || 0), 0),
    state: states.includes('out') ? 'out' : states.includes('low') ? 'low' : 'ok',
  };
}

/** Days the stock lasts at the recent selling speed (null = not selling). */
export function daysLeft(stock: number, soldInDays: number, days: number): number | null {
  if (soldInDays <= 0 || days <= 0) return null;
  if (stock <= 0) return 0;
  return Math.floor(stock / (soldInDays / days));
}

const ASK_WORDS = [
  'thiyenawa', 'tiyenawa', 'thiyanawa', 'tiyanawa', 'thiyeda', 'thiyenwa', 'thiyenavada', 'thiyenawada', 'tiyenawada', 'thibba', 'denna puluwan',
  'available', 'availability', 'in stock', 'have', 'got', 'sell', 'price', 'kiyada', 'kiyeda', 'keeyada', 'kiyak', 'ganana', 'ganan',
  'තියෙනවද', 'තියනවද', 'තියෙනවා ද', 'තියෙද', 'කීයද', 'මිල', 'ගාන', 'ලැබෙනවද',
  'இருக்கா', 'இருக்கிறதா', 'உள்ளதா', 'கிடைக்குமா', 'விலை', 'எவ்வளவு',
];
const NOT_PRODUCT = /\b(deliver|delivery|cod|address|order\s*(eka|ek)?\s*(awe|aawe|kohed|status)|track|open|close|location|branch|time|bank|slip|refund|cancel|invoice|bill|thanks|thank you|ok|okay|hi|hello)\b/i;

/** The customer's message asks whether the shop has / what costs a product ("Huggies thiyenawada?", "do you have …"). */
export function looksLikeProductQuestion(text: string): boolean {
  const t = String(text ?? '').trim().toLowerCase();
  if (t.length < 4 || t.length > 220) return false;
  if (!ASK_WORDS.some((w) => t.includes(w))) return false;
  // "delivery kiyada?", "branch eka open da?" are not product questions
  const words = t.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (NOT_PRODUCT.test(t) && words.length <= 4) return false;
  return words.some((w) => w.length >= 3);
}

const NEGATIVE = [
  "don't have", 'do not have', "don't sell", 'do not sell', 'not available', 'unavailable', 'no stock', 'out of stock', 'not in stock',
  "we don't carry", 'sorry, we', 'currently not', 'not selling',
  'naha', 'nehe', 'nathi', 'netha', 'nemei', 'nae ', 'නැහැ', 'නෑ', 'නැත', 'නොමැත', 'ඉවරයි',
  'இல்லை', 'கிடைக்காது', 'இல்லீங்க',
];

/** The bot's reply tells the customer the shop does not have it. */
export function saysNotAvailable(reply: string): boolean {
  const t = ` ${String(reply ?? '').toLowerCase()} `;
  return NEGATIVE.some((w) => t.includes(w));
}

/** A question's normal form, for grouping the same ask from many customers ("Huggies thiyenawada?" = "huggies thiyenawada"). */
export function normalQuestion(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Middle value of the gaps (days) between purchase dates – how often a customer buys a product. */
export function typicalGapDays(dates: Array<string | Date>): number | null {
  const times = [...new Set(dates.map((d) => new Date(d).setHours(0, 0, 0, 0)))].sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / 86_400_000)).filter((g) => g > 0).sort((a, b) => a - b);
  if (!gaps.length) return null;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

export type ReorderState = 'overdue' | 'due' | 'soon' | 'later';

/** When the customer probably needs the product again. due = within 3 days, soon = within `soonDays`. */
export function reorderState(lastBought: string | Date, everyDays: number, today = new Date(), soonDays = 7): { due_on: string; days_until: number; state: ReorderState } {
  const last = new Date(lastBought);
  last.setHours(0, 0, 0, 0);
  const due = new Date(last.getTime() + everyDays * 86_400_000);
  const now = new Date(today);
  now.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((due.getTime() - now.getTime()) / 86_400_000);
  const state: ReorderState = daysUntil < 0 ? 'overdue' : daysUntil <= 3 ? 'due' : daysUntil <= soonDays ? 'soon' : 'later';
  const pad = (n: number) => String(n).padStart(2, '0');
  return { due_on: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`, days_until: daysUntil, state };
}
