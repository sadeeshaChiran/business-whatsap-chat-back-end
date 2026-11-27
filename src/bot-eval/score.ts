import { COMMENT_SOURCE } from '../marketing/attribution';
import type { SalesBotContext } from '../sales-bot/sales-bot-context.service';
import type { SalesBotResult, SalesBotTurn } from '../sales-bot/sales-bot.client';

/** One test message from a real chat (scratch eval/cases.json, made by gen.py). */
export type EvalCase = {
  id: string;
  shop: string;
  company_id: number;
  conversation_id: number;
  channel_user_id: number | null;
  platform: string;
  before_message_id: number;
  message: string;
  kind: string;
  note?: string;
  checks: {
    expect_products_any?: number[];
    forbid_products?: number[];
    expect_text_any?: string[];
    forbid_text?: string[];
    max_chars?: number;
    no_handoff?: boolean;
    sinhala_script?: boolean;
    prices_known?: boolean;
    no_duplicate_order_of?: number[];
    campaign_from_comment?: boolean;
  };
};

export type CaseScore = {
  id: string;
  shop: string;
  kind: string;
  pass: boolean;
  /** check name -> passed */
  checks: Record<string, boolean>;
  /** why each failed check failed */
  fails: string[];
};

const words = (text: string) =>
  String(text ?? '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w.length >= 3);

/** "… eka iwarai", "out of stock", "stock නැහැ": the reply says this product is NOT available (not offering it). */
const SOLD_OUT_WORDS = /iwar|ivar|ඉවර|out\s+of\s+stock|sold\s*out|not\s+available|no\s+stock|stock\s*(?:eka\s*)?(?:na|naha|nehe|nathi)|stock\s*(?:නැ|නෑ|නැහැ)|තොගයේ\s*නැ|stock\s*ඉවර/i;

/** The sentence / line of the reply where this text is. */
function sentenceOf(reply: string, at: number): string {
  const start = Math.max(reply.lastIndexOf('\n', at), reply.lastIndexOf('.', at), reply.lastIndexOf('!', at), reply.lastIndexOf('?', at)) + 1;
  const ends = ['\n', '.', '!', '?'].map((c) => reply.indexOf(c, at)).filter((i) => i >= 0);
  return reply.slice(start, ends.length ? Math.min(...ends) : reply.length);
}

/** Products the reply is about: photos sent, size charts, order items, and products named in the text.
 * offeredOnly: a product named only to say it is sold out ("X eka iwarai, mewa thiyenawa") does not count. */
export function productsShown(result: SalesBotResult, context: SalesBotContext, offeredOnly = false): Set<number> {
  const ids = new Set<number>();
  for (const id of result.photo_product_ids ?? []) ids.add(Number(id));
  for (const v of result.photo_variants ?? []) ids.add(Number(v.product_id));
  for (const id of result.size_chart_product_ids ?? []) ids.add(Number(id));
  for (const item of result.order?.items ?? []) ids.add(Number(item.product_id));
  const reply = String(result.reply ?? '').toLowerCase();
  const replyWords = new Set(words(reply));
  for (const product of context.products ?? []) {
    const name = String(product.name ?? '').toLowerCase().trim();
    if (!name) continue;
    if (name.length >= 6 && reply.includes(name)) {
      if (!(offeredOnly && SOLD_OUT_WORDS.test(sentenceOf(reply, reply.indexOf(name))))) ids.add(product.id);
      continue;
    }
    const sku = String(product.sku ?? '').toLowerCase();
    if (sku.length >= 4 && replyWords.has(sku)) { ids.add(product.id); continue; }
    const nameWords = [...new Set(words(name))];
    if (nameWords.length >= 2 && nameWords.filter((w) => replyWords.has(w)).length / nameWords.length >= 0.75) {
      const at = reply.indexOf(nameWords.find((w) => reply.includes(w)) ?? '');
      if (!(offeredOnly && at >= 0 && SOLD_OUT_WORDS.test(sentenceOf(reply, at)))) ids.add(product.id);
    }
  }
  return ids;
}

/** Rupee amounts written in the reply ("Rs 1,250", "රු. 425", "1500/-"). */
export function pricesInText(text: string): number[] {
  const out: number[] = [];
  const re = /(?:rs\.?|lkr|රු\.?|රුපියල්)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]{2,}(?:\.[0-9]+)?)\s*(?:\/-|rs\b|රු|රුපියල්|rupees)/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const n = Number(String(m[1] ?? m[2]).replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 10) out.push(n);
  }
  return out;
}

/** Every number the bot could rightly say: prices (× 1–10), delivery fees (with extra kg), + a fee, totals of the order. */
export function knownPrice(value: number, context: SalesBotContext, otherText: string): boolean {
  const prices = new Set<number>();
  for (const p of context.products ?? []) {
    if (p.price > 0) prices.add(Number(p.price));
    for (const v of p.variants ?? []) if (v.price > 0) prices.add(Number(v.price));
  }
  for (const s of context.services ?? []) if (s.price > 0) prices.add(Number(s.price));
  const fees = new Set<number>([0]);
  for (const z of context.delivery_zones ?? []) {
    const fee = Number(z.fee) || 0;
    fees.add(fee);
    if (z.per_extra_kg) for (let kg = 1; kg <= 10; kg++) fees.add(fee + kg * Number(z.per_extra_kg));
  }
  if (context.company?.free_delivery_over) prices.add(Number(context.company.free_delivery_over));
  for (const fee of fees) if (fee > 0 && fee === value) return true;
  // numbers the shop wrote itself (training, the ad, earlier messages)
  const written = new Set((String(otherText).match(/[0-9][0-9,]*/g) ?? []).map((n) => Number(n.replace(/,/g, ''))));
  if (written.has(value)) return true;
  for (const price of prices) {
    for (let qty = 1; qty <= 10; qty++) {
      const subtotal = price * qty;
      for (const fee of fees) if (Math.abs(subtotal + fee - value) < 1) return true;
      for (const other of written) if (other > 0 && Math.abs(subtotal + other - value) < 1) return true;
    }
  }
  return false;
}

/** The shop's own long answer (price list, size chart text) copied into the reply is the owner's style, not a long
 * reply: the limit grows by that answer's length when most of its lines are in the reply. */
export function lengthLimit(base: number, reply: string, context: SalesBotContext): number {
  let limit = base;
  const texts = [
    ...(context.policies ?? []), ...(context.faqs ?? []), ...(context.styles ?? []),
  ].map((p) => String(p.answer ?? '')).concat(String(context.company?.greeting ?? ''));
  for (const text of texts) {
    if (text.length < 200) continue;
    const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 8);
    if (lines.length && lines.filter((l) => reply.includes(l)).length / lines.length >= 0.6) limit = Math.max(limit, text.length + base);
  }
  return limit;
}

/** A handoff that is right: payment slip to check, an upset / complaining customer, a damaged or missing order. */
const RIGHT_HANDOFF = /bank|transfer|receipt|slip|verify|payment\s+proof|upset|angry|complain|refund|return|damag|broken|missing|not\s+received|wrong\s+item|problem|බැංකු|රිසිට්|slip|කේන්ති|තරහ|පැමිණිල|කැඩ|නැති වෙලා|ලැබුණේ නැ|වැරදි|ප්‍රශ්න|ගැටළු|ගැටලු|අසතුටු/i;

/** Score one bot answer. orderItems: order id -> product ids (for no_duplicate_order_of). */
export function scoreCase(
  testCase: EvalCase,
  result: SalesBotResult,
  context: SalesBotContext,
  history: SalesBotTurn[],
  orderItems: Record<number, number[]> = {},
): CaseScore {
  const checks: Record<string, boolean> = {};
  const fails: string[] = [];
  const c = testCase.checks ?? {};
  const reply = String(result.reply ?? '');
  const lower = reply.toLowerCase();
  const shown = productsShown(result, context);
  const offered = productsShown(result, context, true);
  const set = (name: string, ok: boolean, why: string) => {
    checks[name] = ok;
    if (!ok) fails.push(`${name}: ${why}`);
  };

  if (c.expect_products_any?.length) {
    set('expect_products', c.expect_products_any.some((id) => shown.has(id)),
      `wanted #${c.expect_products_any.join('/#')}, got ${shown.size ? [...shown].slice(0, 6).map((id) => `#${id}`).join(' ') : 'none'}`);
  }
  if (c.forbid_products?.length) {
    const bad = c.forbid_products.filter((id) => offered.has(id));
    set('forbid_products', bad.length === 0, `showed #${bad.join(' #')}`);
  }
  if (c.expect_text_any?.length) {
    set('expect_text', c.expect_text_any.some((t) => lower.includes(t.toLowerCase())), `none of: ${c.expect_text_any.join(', ')}`);
  }
  if (c.forbid_text?.length) {
    const bad = c.forbid_text.filter((t) => lower.includes(t.toLowerCase()));
    set('forbid_text', bad.length === 0, `said: ${bad.join(', ')}`);
  }
  if (c.max_chars) {
    const limit = lengthLimit(c.max_chars, reply, context);
    set('short', reply.length <= limit, `${reply.length} chars (limit ${limit})`);
  }
  if (c.no_handoff) {
    const reason = String(result.handoff?.reason ?? '');
    set('no_handoff', !result.handoff?.needed || RIGHT_HANDOFF.test(reason), `handoff: ${reason.slice(0, 80)}`);
  }
  if (c.sinhala_script) set('sinhala', /[඀-෿]/.test(reply), 'no Sinhala letters');
  if (c.prices_known) {
    const other = [
      testCase.message,
      ...history.map((t) => t.text),
      JSON.stringify(context.campaign ?? ''),
      ...(context.policies ?? []).map((p) => p.answer), ...(context.faqs ?? []).map((p) => p.answer), ...(context.styles ?? []).map((p) => p.answer),
      JSON.stringify(context.open_orders ?? []), JSON.stringify(context.last_order ?? ''),
    ].join('\n');
    const unknown = pricesInText(reply).filter((n) => !knownPrice(n, context, other));
    set('prices_known', unknown.length === 0, `unknown Rs ${unknown.join(', ')}`);
  }
  if (c.no_duplicate_order_of?.length) {
    const items = (result.order?.items ?? []).map((i) => Number(i.product_id));
    const dup = result.order?.confirm_order === true && items.length > 0
      && c.no_duplicate_order_of.some((orderId) => items.every((id) => (orderItems[orderId] ?? []).includes(id)));
    set('no_duplicate_order', !dup, 'confirmed the same items again');
  }
  if (c.campaign_from_comment) {
    set('comment_post', context.campaign?.source === COMMENT_SOURCE, 'the chat did not get its post');
  }
  // every case: never offer a sold-out product. Photos of a switched-off product are dropped by the backend
  // (sales-bot-engine sendPhotos), so only the photos customers would really get count – and every order item.
  const byId = new Map((context.products ?? []).map((p) => [p.id, p]));
  const isSoldOut = (p: (typeof context.products)[number] | undefined) =>
    Boolean(p && (p.available === false || (p.stock !== null && p.stock !== undefined && p.stock <= 0 && !(p.variants ?? []).some((v) => (v.stock ?? 1) > 0))));
  const sentPhotos = (result.photo_product_ids ?? []).filter((id) => byId.get(Number(id))?.available !== false);
  const ordered = (result.order?.items ?? []).map((i) => Number(i.product_id));
  const soldOut = [...new Set([...sentPhotos, ...ordered])].filter((id) => isSoldOut(byId.get(Number(id))));
  set('no_sold_out', soldOut.length === 0, `sold out #${soldOut.join(' #')}`);
  if (!reply.trim() && !result.handoff?.needed) set('replied', false, 'empty reply');

  return { id: testCase.id, shop: testCase.shop, kind: testCase.kind, pass: fails.length === 0, checks, fails };
}

export type RunRow = CaseScore & {
  reply: string;
  usage: SalesBotResult['usage'] | null;
  error?: string;
  ms: number;
};

/** Pass % by shop / kind / check, cost and tokens. */
export function summarize(rows: RunRow[]) {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const group = (key: (r: RunRow) => string) => {
    const out: Record<string, { cases: number; pass: number; pass_pct: number }> = {};
    for (const r of rows) {
      const k = key(r);
      out[k] ??= { cases: 0, pass: 0, pass_pct: 0 };
      out[k].cases += 1;
      if (r.pass) out[k].pass += 1;
    }
    for (const v of Object.values(out)) v.pass_pct = pct(v.pass, v.cases);
    return out;
  };
  const checks: Record<string, { run: number; pass: number; pass_pct: number }> = {};
  for (const r of rows) {
    for (const [name, ok] of Object.entries(r.checks)) {
      checks[name] ??= { run: 0, pass: 0, pass_pct: 0 };
      checks[name].run += 1;
      if (ok) checks[name].pass += 1;
    }
  }
  for (const v of Object.values(checks)) v.pass_pct = pct(v.pass, v.run);
  const cost = rows.reduce((s, r) => s + Number(r.usage?.cost_usd ?? 0), 0);
  const tokens = rows.reduce((s, r) => s + Number(r.usage?.input_tokens ?? 0) + Number(r.usage?.output_tokens ?? 0) + Number(r.usage?.thinking_tokens ?? 0), 0);
  const ok = rows.filter((r) => !r.error);
  return {
    cases: rows.length,
    pass: rows.filter((r) => r.pass).length,
    pass_pct: pct(rows.filter((r) => r.pass).length, rows.length),
    errors: rows.length - ok.length,
    cost_usd: Math.round(cost * 10000) / 10000,
    cost_per_reply_usd: ok.length ? Math.round((cost / ok.length) * 1_000_000) / 1_000_000 : 0,
    tokens_per_reply: ok.length ? Math.round(tokens / ok.length) : 0,
    by_shop: group((r) => r.shop),
    by_kind: group((r) => `${r.shop}/${r.kind}`),
    by_check: checks,
  };
}

/** Cases that passed in `before` and fail in `after` (and the other way). */
export function compareRuns(before: RunRow[], after: RunRow[]) {
  const old = new Map(before.map((r) => [r.id, r]));
  const broke: Array<{ id: string; fails: string[]; reply: string }> = [];
  const fixed: string[] = [];
  for (const r of after) {
    const o = old.get(r.id);
    if (!o) continue;
    if (o.pass && !r.pass) broke.push({ id: r.id, fails: r.fails, reply: r.reply.slice(0, 300) });
    if (!o.pass && r.pass) fixed.push(r.id);
  }
  return { before: summarize(before), after: summarize(after), newly_failing: broke, newly_passing: fixed };
}
