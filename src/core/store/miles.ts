import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { storeCreditLedger } from "../../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("store");

/**
 * Miles: the store currency bought with real money, as Discord consumable SKUs. Discord tells the
 * bot about a purchase with an entitlement; the bot pays the pack's Miles into the ledger (once per
 * entitlement id, enforced by a unique index), consumes the entitlement so it can be bought again,
 * then DMs a receipt. A reconcile pass on boot and every 10 minutes picks up anything the gateway
 * event missed (the bot was down, or consuming failed).
 */

/** Discord's own app id for Dreamliner (the store page links to it). Same as the One SKU's app. */
const DEFAULT_APPLICATION_ID = "1524053555114151946";

export type MilesPackDef = { id: string; miles: number; price: string; envKey: string };

export const MILES_PACK_DEFS: readonly MilesPackDef[] = [
  { id: "miles_2000", miles: 2000, price: "£1.99", envKey: "DISCORD_MILES_SKU_2000" },
  { id: "miles_5500", miles: 5500, price: "£4.99", envKey: "DISCORD_MILES_SKU_5500" },
  { id: "miles_12000", miles: 12000, price: "£9.99", envKey: "DISCORD_MILES_SKU_12000" },
  { id: "miles_26000", miles: 26000, price: "£39.99", envKey: "DISCORD_MILES_SKU_26000" },
];

export type MilesPack = {
  id: string;
  miles: number;
  price: string;
  skuId: string | null;
  /** Discord's app-directory store page for this SKU, or null without one. */
  url: string | null;
};

function applicationId(): string {
  return process.env.DISCORD_CLIENT_ID?.trim() || DEFAULT_APPLICATION_ID;
}

/** The packs, with SKU ids read from the environment (packs without one show skuId null). */
export function getMilesPacks(): MilesPack[] {
  const appId = applicationId();
  return MILES_PACK_DEFS.map((def) => {
    const skuId = process.env[def.envKey]?.trim() || null;
    const valid = skuId && /^\d{15,25}$/.test(skuId) ? skuId : null;
    return {
      id: def.id,
      miles: def.miles,
      price: def.price,
      skuId: valid,
      url: valid ? `https://discord.com/application-directory/${appId}/store/${valid}` : null,
    };
  });
}

export function milesPackForSku(skuId: string): MilesPack | null {
  return getMilesPacks().find((pack) => pack.skuId === skuId) ?? null;
}

export function milesSkuIds(): string[] {
  return getMilesPacks().flatMap((pack) => (pack.skuId ? [pack.skuId] : []));
}

export function getMilesBalance(userId: string): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${storeCreditLedger.delta}), 0)` })
    .from(storeCreditLedger)
    .where(and(eq(storeCreditLedger.userId, userId), eq(storeCreditLedger.currency, "miles")))
    .get();
  return Number(row?.total ?? 0);
}

/** Pays a Miles purchase. Idempotent by entitlement id: a second call pays nothing. */
export function grantMilesForEntitlement(input: {
  entitlementId: string;
  userId: string;
  miles: number;
  now?: Date;
}): { granted: boolean; balance: number } {
  const result = getDb()
    .insert(storeCreditLedger)
    .values({
      userId: input.userId,
      delta: input.miles,
      kind: "miles_purchase",
      currency: "miles",
      entitlementId: input.entitlementId,
      createdAt: input.now ?? new Date(),
    })
    .onConflictDoNothing()
    .run();
  return { granted: result.changes > 0, balance: getMilesBalance(input.userId) };
}

export function isMilesEntitlementPaid(entitlementId: string): boolean {
  return Boolean(
    getDb().select({ id: storeCreditLedger.id }).from(storeCreditLedger).where(eq(storeCreditLedger.entitlementId, entitlementId)).get(),
  );
}

export const MAX_GRANT = 100_000;

export class StoreGrantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A superuser grant (or, with a negative amount, a correction) of Miles or credits. */
export function grantCurrency(input: {
  actorId: string;
  targetUserId: string;
  currency: "miles" | "credits";
  amount: number;
  note: string | null;
  now?: Date;
}): { balance: number } {
  if (!Number.isInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > MAX_GRANT) {
    throw new StoreGrantError(`amount must be a non-zero whole number from -${MAX_GRANT} to ${MAX_GRANT}.`, 400);
  }
  return getDb().transaction((tx) => {
    const balanceOf = () =>
      Number(
        tx
          .select({ total: sql<number>`coalesce(sum(${storeCreditLedger.delta}), 0)` })
          .from(storeCreditLedger)
          .where(and(eq(storeCreditLedger.userId, input.targetUserId), eq(storeCreditLedger.currency, input.currency)))
          .get()?.total ?? 0,
      );
    const before = balanceOf();
    if (before + input.amount < 0) {
      throw new StoreGrantError(`That would leave a negative balance (they have ${before}).`, 409);
    }
    tx.insert(storeCreditLedger)
      .values({
        userId: input.targetUserId,
        delta: input.amount,
        kind: "grant",
        currency: input.currency,
        note: input.note ? `${input.note.slice(0, 200)} (by ${input.actorId})` : `by ${input.actorId}`,
        createdAt: input.now ?? new Date(),
      })
      .run();
    return { balance: before + input.amount };
  });
}

// --- Discord entitlements --------------------------------------------------------------------

/** The parts of a discord.js Entitlement this needs (so tests can pass a plain object). */
export type MilesEntitlementLike = {
  id: string;
  skuId: string;
  userId: string | null;
  consumed?: boolean;
  deleted?: boolean;
};

export type MilesEntitlementDeps = {
  consume(entitlementId: string): Promise<void>;
  /** Best-effort receipt DM. */
  notify?(userId: string, message: string): Promise<void>;
};

export type MilesEntitlementResult = "granted" | "already_paid" | "ignored" | "consume_failed";

/** Consumed in this process (Discord's flag on a cached entitlement can lag behind). */
const consumedHere = new Set<string>();

export function milesReceiptText(miles: number, balance: number): string {
  return `Thanks for your purchase! **${miles.toLocaleString("en-GB")} Miles** were added to your Dreamliner balance. You now have **${balance.toLocaleString("en-GB")} Miles** to spend on cosmetics in the Dreamliner Store.`;
}

/** Pays, consumes and confirms one Miles entitlement. Safe to call any number of times. */
export async function processMilesEntitlement(entitlement: MilesEntitlementLike, deps: MilesEntitlementDeps): Promise<MilesEntitlementResult> {
  const pack = milesPackForSku(entitlement.skuId);
  if (!pack || entitlement.deleted) return "ignored";
  if (!entitlement.userId) {
    log.warn(`[miles] Entitlement ${entitlement.id} for ${pack.id} has no user, so there is no one to pay.`);
    return "ignored";
  }
  const { granted, balance } = grantMilesForEntitlement({ entitlementId: entitlement.id, userId: entitlement.userId, miles: pack.miles });
  if (granted) log.info(`[miles] ${entitlement.userId} bought ${pack.miles} Miles (entitlement ${entitlement.id}).`);

  if (!entitlement.consumed && !consumedHere.has(entitlement.id)) {
    try {
      await deps.consume(entitlement.id);
      consumedHere.add(entitlement.id);
      if (consumedHere.size > 10_000) consumedHere.clear();
    } catch (error) {
      // The Miles are paid already; the next reconcile retries consuming it.
      log.warn(`[miles] Couldn't consume entitlement ${entitlement.id}; will retry.`, error);
      if (granted) await deps.notify?.(entitlement.userId, milesReceiptText(pack.miles, balance)).catch(() => undefined);
      return "consume_failed";
    }
  }
  if (granted) await deps.notify?.(entitlement.userId, milesReceiptText(pack.miles, balance)).catch(() => undefined);
  return granted ? "granted" : "already_paid";
}

/** A source of entitlements pages (client.application.entitlements.fetch in production). */
export type EntitlementPageFetcher = (options: { skus: string[]; after?: string; limit: number }) => Promise<MilesEntitlementLike[]>;

function snowflakeMinusOne(id: string): string {
  return (BigInt(id) - 1n).toString();
}

/**
 * Settles every unconsumed Miles entitlement after the stored cursor, then moves the cursor up to
 * just below the oldest one still unsettled (or to the newest seen when all are settled).
 */
export async function reconcileMilesEntitlements(
  fetchPage: EntitlementPageFetcher,
  deps: MilesEntitlementDeps,
  cursorStore: { get(): string | null; set(cursor: string): void },
): Promise<{ processed: number; granted: number }> {
  const skus = milesSkuIds();
  if (skus.length === 0) return { processed: 0, granted: 0 };
  let after = cursorStore.get() ?? undefined;
  let processed = 0;
  let granted = 0;
  let oldestUnsettled: string | null = null;
  let newest: string | null = null;

  for (let page = 0; page < 50; page++) {
    const batch = await fetchPage({ skus, after, limit: 100 });
    if (batch.length === 0) break;
    const sorted = [...batch].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const entitlement of sorted) {
      newest = entitlement.id;
      if (entitlement.consumed || entitlement.deleted) continue;
      processed++;
      const result = await processMilesEntitlement(entitlement, deps);
      if (result === "granted") granted++;
      if (result === "consume_failed" && oldestUnsettled === null) oldestUnsettled = entitlement.id;
    }
    after = sorted[sorted.length - 1]!.id;
    if (batch.length < 100) break;
  }

  const next = oldestUnsettled ? snowflakeMinusOne(oldestUnsettled) : newest;
  if (next) cursorStore.set(next);
  return { processed, granted };
}
