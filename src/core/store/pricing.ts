/**
 * Store credit pricing. The website reads these from the store payload instead of keeping its own
 * copy, so the account page can never disagree with what the bot actually charges.
 */
export const STORE_PRICING = {
  /** Credits paid for each top.gg vote. */
  creditsPerVote: 10,
  /** Credits for one day of Dreamliner One. */
  creditsPerDay: 20,
  /** Days are bought in steps of this size, starting at one step. */
  dayStep: 2,
  /** Most days one purchase can add. */
  maxDaysPerPurchase: 90,
} as const;

export type StorePricing = typeof STORE_PRICING;

/** 2, 4, 6, ... up to the per-purchase cap. */
export function isValidPurchaseDays(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= STORE_PRICING.dayStep &&
    days <= STORE_PRICING.maxDaysPerPurchase &&
    days % STORE_PRICING.dayStep === 0
  );
}

export function purchaseCost(days: number): number {
  return days * STORE_PRICING.creditsPerDay;
}

/** The most days a balance can buy (0 when it can't cover the smallest purchase). */
export function maxAffordableDays(balance: number): number {
  const step = STORE_PRICING.dayStep;
  const affordable = Math.floor(balance / STORE_PRICING.creditsPerDay / step) * step;
  return Math.min(STORE_PRICING.maxDaysPerPurchase, affordable);
}
