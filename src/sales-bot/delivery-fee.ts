/**
 * Delivery fee with an optional weight rule (same formula as the Python bot's delivery_fee tool):
 *   fee = base fee + max(0, order kg - included_kg) × per_extra_kg      (exact kg, no rounding up)
 * A zone without a weight rule (included_kg or per_extra_kg empty) has a flat fee.
 */
export type ZoneRule = { area: string; fee: number | string; included_kg?: number | string | null; per_extra_kg?: number | string | null };

export function hasWeightRule(zone: ZoneRule): boolean {
  return zone.included_kg != null && zone.per_extra_kg != null && Number(zone.per_extra_kg) > 0;
}

export function zoneFee(zone: ZoneRule, weightKg: number): number {
  const base = Number(zone.fee) || 0;
  if (!hasWeightRule(zone)) return base;
  const extraKg = Math.max(0, (Number(weightKg) || 0) - Number(zone.included_kg));
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
