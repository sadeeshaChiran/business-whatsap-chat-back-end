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

/** Fee of an order: free when the subtotal reaches the shop's "free delivery over" amount, else the zone fee. */
export function orderDeliveryFee(zone: ZoneRule, weightKg: number, subtotal: number, freeOver: number | null | undefined): number {
  if (freeOver != null && Number(freeOver) > 0 && subtotal >= Number(freeOver)) return 0;
  return zoneFee(zone, weightKg);
}
