import type { PlatformPackage } from './entities/platform-package.entity';

/** Offer prices end at the end of the "until" day in Sri Lanka. */
const SRI_LANKA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type Cycle = 'monthly' | 'yearly';

export interface PackageOffer {
  /** offer price for each cycle; null = that cycle has no offer */
  price_monthly: number | null;
  price_yearly: number | null;
  /** last day of the offer, YYYY-MM-DD (inclusive) */
  until: string;
  label: string;
}

const money = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** Today's date in Sri Lanka as YYYY-MM-DD. */
export function sriLankaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SRI_LANKA_OFFSET_MS).toISOString().slice(0, 10);
}

function untilText(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * The package's offer if it is running now, else null.
 * An offer price only counts when it is lower than the normal price for that cycle.
 */
export function activeOffer(pkg: Pick<PlatformPackage, 'price_monthly' | 'price_yearly' | 'offer_price_monthly' | 'offer_price_yearly' | 'offer_until' | 'offer_label'>, now: Date = new Date()): PackageOffer | null {
  const until = untilText(pkg.offer_until);
  if (!until || sriLankaToday(now) > until) return null;
  const monthly = money(pkg.offer_price_monthly);
  const yearly = money(pkg.offer_price_yearly);
  const offerMonthly = monthly !== null && monthly < Number(pkg.price_monthly) ? monthly : null;
  const offerYearly = yearly !== null && yearly < Number(pkg.price_yearly) ? yearly : null;
  if (offerMonthly === null && offerYearly === null) return null;
  return { price_monthly: offerMonthly, price_yearly: offerYearly, until, label: String(pkg.offer_label ?? '').trim() };
}

/** What the company pays today for this package and cycle. */
export function priceFor(pkg: Parameters<typeof activeOffer>[0], cycle: Cycle, now: Date = new Date()): { amount: number; offer: PackageOffer | null } {
  const offer = activeOffer(pkg, now);
  const offerPrice = offer ? (cycle === 'yearly' ? offer.price_yearly : offer.price_monthly) : null;
  if (offer && offerPrice !== null) return { amount: offerPrice, offer };
  return { amount: Number(cycle === 'yearly' ? pkg.price_yearly : pkg.price_monthly) || 0, offer: null };
}

/** Fields every package view sends to the web app. */
export function offerFields(pkg: Parameters<typeof activeOffer>[0], tokensPerReply: number, tokensPerMonth: number) {
  return {
    offer: activeOffer(pkg),
    /** rough number of AI replies the monthly tokens give (shown as "≈ 2,500 AI replies") */
    approx_replies: tokensPerReply > 0 ? Math.round(Number(tokensPerMonth || 0) / tokensPerReply / 10) * 10 : null,
  };
}
