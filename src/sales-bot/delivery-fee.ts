/**
 * Delivery fee with an optional weight rule (same formula as the Python bot's delivery_fee tool):
 *   counted kg = order kg rounded as the zone says: up (2.3 -> 3), nearest (2.3 -> 2, 2.5 -> 3) or exact (2.3)
 *   fee = base fee + max(0, counted kg - included_kg) × per_extra_kg
 * A zone without a weight rule (included_kg or per_extra_kg empty) has a flat fee.
 */
export type WeightRounding = 'up' | 'nearest' | 'exact';
export type ZoneRule = { area: string; fee: number | string; included_kg?: number | string | null; per_extra_kg?: number | string | null; weight_rounding?: string | null };

/** The weight the fee is counted on. Tiny float noise (2.0000001) never pushes it up a kg. */
export function countedKg(weightKg: number, rounding: string | null | undefined): number {
  const kg = Math.max(0, Math.round((Number(weightKg) || 0) * 1000) / 1000);
  if (rounding === 'exact') return kg;
  if (rounding === 'nearest') return Math.round(kg);
  return Math.ceil(kg); // 'up' (default)
}

export function hasWeightRule(zone: ZoneRule): boolean {
  return zone.included_kg != null && zone.per_extra_kg != null && Number(zone.per_extra_kg) > 0;
}

export function zoneFee(zone: ZoneRule, weightKg: number): number {
  const base = Number(zone.fee) || 0;
  if (!hasWeightRule(zone)) return base;
  const extraKg = Math.max(0, countedKg(weightKg, zone.weight_rounding) - Number(zone.included_kg));
  return Math.round((base + extraKg * Number(zone.per_extra_kg)) * 100) / 100;
}

/** The zone for an area name: exact match (case-insensitive), else "*" (everywhere else), else none. */
export function findZone<T extends ZoneRule>(zones: T[], area: string | null | undefined): T | null {
  const wanted = String(area ?? '').trim().toLowerCase();
  if (wanted) {
    const exact = zones.find((zone) => zone.area.trim().toLowerCase() === wanted);
    if (exact) return exact;
  }
  return zones.find((zone) => zone.area.trim() === '*') ?? null;
}

/**
 * Shop delivery rules by item counts (bot_sales_settings.delivery_rules, NULL for most shops = not used).
 * kinds tag the order items: products (ids), product_has (words in the product name), option_has (words in the option,
 * e.g. "T-Shirt"); all given parts must match. An item can have several kinds.
 * rules are checked in order and the FIRST one whose conditions all hold gives the fee ("zone" = the normal zone fee);
 * a condition can add kinds: "tee+kit_tee": ">=3".
 *   { "kinds": { "tee": { "products": [7188], "option_has": ["T-Shirt"] }, "pant": { "option_has": ["Pant"] } },
 *     "rules": [ { "when": { "tee": ">=3" }, "fee": 0 }, { "when": { "pant": ">=1" }, "fee": 425 }, { "when": { "tee": ">=1" }, "fee": 130 } ] }
 * No rule matches → the shop's normal fee (free delivery over / zone).
 */
export type DeliveryRuleKind = { products?: number[]; product_has?: string[]; option_has?: string[] };
export type DeliveryRule = { when: Record<string, string>; fee: number | 'zone'; note?: string };
export type DeliveryRules = { kinds: Record<string, DeliveryRuleKind>; rules: DeliveryRule[] };
export type RuleItem = { product_id: number | null | undefined; product_name?: string | null; option?: string | null; quantity: number };

function itemHasKind(item: RuleItem, kind: DeliveryRuleKind): boolean {
  const products = (kind.products ?? []).map(Number);
  if (products.length && !products.includes(Number(item.product_id))) return false;
  const names = (kind.product_has ?? []).map((word) => String(word).toLowerCase()).filter(Boolean);
  if (names.length && !names.some((word) => String(item.product_name ?? '').toLowerCase().includes(word))) return false;
  const words = (kind.option_has ?? []).map((word) => String(word).toLowerCase()).filter(Boolean);
  if (words.length && !words.some((word) => String(item.option ?? '').toLowerCase().includes(word))) return false;
  return products.length > 0 || names.length > 0 || words.length > 0;
}

/** How many pieces of each kind the order has ("tee": 3, "pant": 1). */
export function kindCounts(rules: DeliveryRules, items: RuleItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, kind] of Object.entries(rules.kinds ?? {})) {
    counts[name] = items.filter((item) => itemHasKind(item, kind)).reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  }
  return counts;
}

function holds(count: number, condition: string): boolean {
  const match = /^\s*(>=|<=|>|<|=|==)?\s*(\d+)\s*$/.exec(String(condition));
  if (!match) return false;
  const value = Number(match[2]);
  switch (match[1] ?? '=') {
    case '>=': return count >= value;
    case '<=': return count <= value;
    case '>': return count > value;
    case '<': return count < value;
    default: return count === value;
  }
}

/** The fee the shop's rules give this order, 'zone' for the normal zone fee, or null when no rule applies. */
export function ruleDeliveryFee(rules: DeliveryRules | null | undefined, items: RuleItem[]): number | 'zone' | null {
  if (!rules || !Array.isArray(rules.rules) || !rules.rules.length || !items.length) return null;
  const counts = kindCounts(rules, items);
  for (const rule of rules.rules) {
    const conditions = Object.entries(rule.when ?? {});
    // "cherie+kit_tee": ">=3" counts both kinds together
    const count = (name: string) => name.split('+').reduce((sum, part) => sum + (counts[part.trim()] ?? 0), 0);
    if (conditions.length && conditions.every(([name, condition]) => holds(count(name), condition))) {
      return rule.fee === 'zone' ? 'zone' : Math.max(0, Number(rule.fee) || 0);
    }
  }
  return null;
}

/** Fee of an order: the shop's delivery rules first (when it has them), then "free delivery over", else the zone fee. */
export function orderDeliveryFee(zone: ZoneRule, weightKg: number, subtotal: number, freeOver: number | null | undefined,
  rules?: DeliveryRules | null, items?: RuleItem[]): number {
  const ruled = ruleDeliveryFee(rules, items ?? []);
  if (typeof ruled === 'number') return ruled;
  if (ruled === 'zone') return zoneFee(zone, weightKg);
  if (freeOver != null && Number(freeOver) > 0 && subtotal >= Number(freeOver)) return 0;
  return zoneFee(zone, weightKg);
}
