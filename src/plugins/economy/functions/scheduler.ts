import type { Client } from "discord.js";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyAccounts, economySchedulerLeases } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { applyBps, getPrimaryCurrencyKey, mutateMoney } from "./money.js";
import { restockDueListings } from "./inventory.js";
import { expireOpenTrades, settleExpiredAuctions } from "./markets.js";
import { listReadyCrafts } from "./crafting.js";
import { loadEconomyConfig } from "./config.js";
import { calendarDay } from "./rewards.js";

function now() {
  return new Date();
}

const LEASE_MS = 55_000;
const SWEEP_TASK = "economy_sweep";

/**
 * Try to acquire a short lease for a guild task. Returns true if this process owns the lease.
 */
export function tryAcquireLease(guildId: string, taskKey: string, leaseMs = LEASE_MS): boolean {
  const db = getDb();
  const until = new Date(Date.now() + leaseMs);
  const existing = db
    .select()
    .from(economySchedulerLeases)
    .where(and(eq(economySchedulerLeases.guildId, guildId), eq(economySchedulerLeases.taskKey, taskKey)))
    .get();

  if (existing && existing.leaseUntil.getTime() > Date.now()) {
    return false;
  }

  if (existing) {
    db.update(economySchedulerLeases)
      .set({ leaseUntil: until, lastRunAt: now() })
      .where(and(eq(economySchedulerLeases.guildId, guildId), eq(economySchedulerLeases.taskKey, taskKey)))
      .run();
  } else {
    db.insert(economySchedulerLeases)
      .values({
        guildId,
        taskKey,
        leaseUntil: until,
        lastRunAt: now(),
        checkpointJson: "{}",
      })
      .run();
  }
  return true;
}

export function releaseLease(guildId: string, taskKey: string) {
  getDb()
    .update(economySchedulerLeases)
    .set({ leaseUntil: new Date(0) })
    .where(and(eq(economySchedulerLeases.guildId, guildId), eq(economySchedulerLeases.taskKey, taskKey)))
    .run();
}

function applyBankInterest(guildId: string, config: EconomyConfig): number {
  if (!config.modules.banking || !config.bank.enabled) return 0;
  const bps = config.bank.interest_bps_daily;
  if (bps <= 0) return 0;

  const day = calendarDay(config.rewards.timezone || "UTC");
  const leaseKey = `bank_interest:${day}`;
  if (!tryAcquireLease(guildId, leaseKey, 86_400_000)) return 0;

  const primary = getPrimaryCurrencyKey(guildId, config);
  const accounts = getDb()
    .select()
    .from(economyAccounts)
    .where(and(eq(economyAccounts.guildId, guildId), eq(economyAccounts.currencyKey, primary)))
    .all()
    .filter((a) => a.bank > 0);

  let credited = 0;
  for (const account of accounts) {
    let interest = applyBps(account.bank, bps);
    if (interest <= 0) continue;
    if (config.bank.max_balance > 0) {
      interest = Math.min(interest, Math.max(0, config.bank.max_balance - account.bank));
    }
    if (interest <= 0) continue;
    try {
      mutateMoney(
        {
          guildId,
          userId: account.userId,
          currencyKey: primary,
          deltaBank: interest,
          reason: "bank_interest",
          idempotencyKey: `bank_interest:${guildId}:${account.userId}:${day}`,
          allowFrozenAccount: true,
        },
        { config, skipPauseCheck: true },
      );
      credited += 1;
    } catch {
      /* skip account */
    }
  }
  return credited;
}

export type EconomySweepResult = {
  guildId: string;
  restocked: number;
  auctionsSettled: number;
  tradesExpired: number;
  craftsReady: number;
  interestAccounts: number;
  skipped?: boolean;
};

export async function processGuildEconomySweep(
  guildId: string,
  config: EconomyConfig,
  opts?: { skipCraftNotifications?: boolean },
): Promise<EconomySweepResult> {
  if (!tryAcquireLease(guildId, SWEEP_TASK)) {
    return {
      guildId,
      restocked: 0,
      auctionsSettled: 0,
      tradesExpired: 0,
      craftsReady: 0,
      interestAccounts: 0,
      skipped: true,
    };
  }

  let restocked = 0;
  let auctionsSettled = 0;
  let tradesExpired = 0;
  let craftsReady = 0;
  let interestAccounts = 0;

  try {
    if (config.modules.shop) {
      restocked = restockDueListings(guildId);
    }
    if (config.modules.auctions) {
      auctionsSettled = settleExpiredAuctions(guildId, config);
    }
    if (config.modules.trading) {
      tradesExpired = expireOpenTrades(guildId, config);
    }
    if (config.modules.crafting && !opts?.skipCraftNotifications) {
      craftsReady = listReadyCrafts(guildId).length;
    }
    interestAccounts = applyBankInterest(guildId, config);
  } finally {
    // keep lease until natural expiry to debounce parallel sweeps
  }

  return { guildId, restocked, auctionsSettled, tradesExpired, craftsReady, interestAccounts };
}

/** Run economy maintenance for every guild the client is in that has economy enabled. */
export async function processEconomySweep(
  client: Client,
  opts?: { skipCraftNotifications?: boolean },
): Promise<EconomySweepResult[]> {
  const results: EconomySweepResult[] = [];
  for (const [guildId] of client.guilds.cache) {
    let config: EconomyConfig | null = null;
    try {
      config = await loadEconomyConfig(guildId);
    } catch {
      continue;
    }
    if (!config) continue;
    try {
      results.push(await processGuildEconomySweep(guildId, config, opts));
    } catch {
      results.push({
        guildId,
        restocked: 0,
        auctionsSettled: 0,
        tradesExpired: 0,
        craftsReady: 0,
        interestAccounts: 0,
        skipped: true,
      });
    }
  }
  return results;
}

/** Optional: mark last checkpoint on a lease row. */
export function setLeaseCheckpoint(guildId: string, taskKey: string, checkpoint: object) {
  getDb()
    .update(economySchedulerLeases)
    .set({ checkpointJson: JSON.stringify(checkpoint) })
    .where(and(eq(economySchedulerLeases.guildId, guildId), eq(economySchedulerLeases.taskKey, taskKey)))
    .run();
}
