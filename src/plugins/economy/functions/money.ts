import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  economyAccounts,
  economyCurrencies,
  economyDailyStats,
  economyGuildState,
  economyProfiles,
  economyTransactions,
} from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";

export type CurrencyKey = string;

export type AccountBalances = {
  pocket: number;
  bank: number;
  frozen: number;
};

export type MoneyMutation = {
  guildId: string;
  userId: string;
  currencyKey: CurrencyKey;
  deltaPocket?: number;
  deltaBank?: number;
  deltaFrozen?: number;
  reason: string;
  actorId?: string | null;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey?: string | null;
  meta?: Record<string, unknown>;
  allowFrozenAccount?: boolean;
};

export class EconomyError extends Error {
  constructor(
    message: string,
    public code:
      | "paused"
      | "frozen"
      | "insufficient"
      | "invalid"
      | "not_found"
      | "conflict"
      | "limit",
  ) {
    super(message);
    this.name = "EconomyError";
  }
}

function now() {
  return new Date();
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function assertInt(n: number, label: string) {
  if (!Number.isInteger(n)) throw new EconomyError(`${label} must be an integer`, "invalid");
}

export function applyBps(amount: number, bps: number): number {
  if (bps <= 0) return 0;
  return Math.floor((amount * bps) / 10_000);
}

export function applyMultiplier(amount: number, bpsBonus: number): number {
  if (bpsBonus <= 0) return amount;
  return Math.floor((amount * (10_000 + bpsBonus)) / 10_000);
}

export function isGuildPaused(guildId: string, config: EconomyConfig): boolean {
  if (config.paused) return true;
  const row = getDb()
    .select()
    .from(economyGuildState)
    .where(eq(economyGuildState.guildId, guildId))
    .get();
  return Boolean(row?.paused);
}

export function setGuildPaused(guildId: string, paused: boolean) {
  const db = getDb();
  const existing = db.select().from(economyGuildState).where(eq(economyGuildState.guildId, guildId)).get();
  if (existing) {
    db.update(economyGuildState)
      .set({ paused, updatedAt: now() })
      .where(eq(economyGuildState.guildId, guildId))
      .run();
  } else {
    db.insert(economyGuildState)
      .values({ guildId, paused, seeded: false, updatedAt: now() })
      .run();
  }
}

export function ensureGuildCurrencies(guildId: string, config: EconomyConfig) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyCurrencies)
    .where(eq(economyCurrencies.guildId, guildId))
    .all();
  if (existing.length > 0) {
    const state = db.select().from(economyGuildState).where(eq(economyGuildState.guildId, guildId)).get();
    if (!state) {
      db.insert(economyGuildState)
        .values({ guildId, paused: false, seeded: true, updatedAt: now() })
        .run();
    } else if (!state.seeded) {
      db.update(economyGuildState)
        .set({ seeded: true, updatedAt: now() })
        .where(eq(economyGuildState.guildId, guildId))
        .run();
    }
    return existing;
  }

  db.insert(economyCurrencies)
    .values([
      {
        guildId,
        key: "coins",
        name: config.currency.name,
        nameSingular: config.currency.name_singular,
        symbol: config.currency.symbol,
        isPrimary: true,
        tradeable: true,
        createdAt: now(),
      },
      {
        guildId,
        key: "gems",
        name: config.currency.secondary_name,
        nameSingular: config.currency.secondary_name_singular,
        symbol: config.currency.secondary_symbol,
        isPrimary: false,
        tradeable: true,
        createdAt: now(),
      },
    ])
    .run();

  const state = db.select().from(economyGuildState).where(eq(economyGuildState.guildId, guildId)).get();
  if (state) {
    db.update(economyGuildState)
      .set({ seeded: true, updatedAt: now() })
      .where(eq(economyGuildState.guildId, guildId))
      .run();
  } else {
    db.insert(economyGuildState)
      .values({ guildId, paused: false, seeded: true, updatedAt: now() })
      .run();
  }

  return db.select().from(economyCurrencies).where(eq(economyCurrencies.guildId, guildId)).all();
}

export function getPrimaryCurrencyKey(guildId: string, config: EconomyConfig): string {
  ensureGuildCurrencies(guildId, config);
  const row = getDb()
    .select()
    .from(economyCurrencies)
    .where(and(eq(economyCurrencies.guildId, guildId), eq(economyCurrencies.isPrimary, true)))
    .get();
  return row?.key ?? "coins";
}

export function ensureProfile(guildId: string, userId: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyProfiles)
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .get();
  if (existing) return existing;
  db.insert(economyProfiles)
    .values({
      guildId,
      userId,
      xp: 0,
      level: 1,
      prestige: 0,
      hideBalances: false,
      frozen: false,
      jobXp: 0,
      jobLevel: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return db
    .select()
    .from(economyProfiles)
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .get()!;
}

export function getAccount(
  guildId: string,
  userId: string,
  currencyKey: string,
): AccountBalances {
  const row = getDb()
    .select()
    .from(economyAccounts)
    .where(
      and(
        eq(economyAccounts.guildId, guildId),
        eq(economyAccounts.userId, userId),
        eq(economyAccounts.currencyKey, currencyKey),
      ),
    )
    .get();
  return {
    pocket: row?.pocket ?? 0,
    bank: row?.bank ?? 0,
    frozen: row?.frozen ?? 0,
  };
}

function ensureAccountRow(guildId: string, userId: string, currencyKey: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyAccounts)
    .where(
      and(
        eq(economyAccounts.guildId, guildId),
        eq(economyAccounts.userId, userId),
        eq(economyAccounts.currencyKey, currencyKey),
      ),
    )
    .get();
  if (existing) return existing;
  db.insert(economyAccounts)
    .values({
      guildId,
      userId,
      currencyKey,
      pocket: 0,
      bank: 0,
      frozen: 0,
      updatedAt: now(),
    })
    .run();
  return db
    .select()
    .from(economyAccounts)
    .where(
      and(
        eq(economyAccounts.guildId, guildId),
        eq(economyAccounts.userId, userId),
        eq(economyAccounts.currencyKey, currencyKey),
      ),
    )
    .get()!;
}

function bumpDailyStats(
  guildId: string,
  patch: Partial<{
    minted: number;
    sunk: number;
    transfers: number;
    shopRevenue: number;
    marketVolume: number;
    adminAdjust: number;
    activeUsers: number;
  }>,
) {
  const db = getDb();
  const day = dayKey();
  const existing = db
    .select()
    .from(economyDailyStats)
    .where(and(eq(economyDailyStats.guildId, guildId), eq(economyDailyStats.day, day)))
    .get();
  if (!existing) {
    db.insert(economyDailyStats)
      .values({
        guildId,
        day,
        minted: patch.minted ?? 0,
        sunk: patch.sunk ?? 0,
        transfers: patch.transfers ?? 0,
        shopRevenue: patch.shopRevenue ?? 0,
        marketVolume: patch.marketVolume ?? 0,
        adminAdjust: patch.adminAdjust ?? 0,
        activeUsers: patch.activeUsers ?? 0,
      })
      .run();
    return;
  }
  db.update(economyDailyStats)
    .set({
      minted: existing.minted + (patch.minted ?? 0),
      sunk: existing.sunk + (patch.sunk ?? 0),
      transfers: existing.transfers + (patch.transfers ?? 0),
      shopRevenue: existing.shopRevenue + (patch.shopRevenue ?? 0),
      marketVolume: existing.marketVolume + (patch.marketVolume ?? 0),
      adminAdjust: existing.adminAdjust + (patch.adminAdjust ?? 0),
      activeUsers: existing.activeUsers + (patch.activeUsers ?? 0),
    })
    .where(and(eq(economyDailyStats.guildId, guildId), eq(economyDailyStats.day, day)))
    .run();
}

/**
 * Atomic money mutation. Uses a SQLite transaction and rejects negative balances.
 * Idempotent when idempotencyKey is provided.
 */
export function mutateMoney(
  mutation: MoneyMutation,
  opts?: { config?: EconomyConfig; skipPauseCheck?: boolean },
): AccountBalances {
  const deltaPocket = mutation.deltaPocket ?? 0;
  const deltaBank = mutation.deltaBank ?? 0;
  const deltaFrozen = mutation.deltaFrozen ?? 0;
  assertInt(deltaPocket, "deltaPocket");
  assertInt(deltaBank, "deltaBank");
  assertInt(deltaFrozen, "deltaFrozen");

  if (deltaPocket === 0 && deltaBank === 0 && deltaFrozen === 0) {
    return getAccount(mutation.guildId, mutation.userId, mutation.currencyKey);
  }

  const db = getDb();
  return db.transaction((tx) => {
    if (mutation.idempotencyKey) {
      const prior = tx
        .select()
        .from(economyTransactions)
        .where(
          and(
            eq(economyTransactions.guildId, mutation.guildId),
            eq(economyTransactions.idempotencyKey, mutation.idempotencyKey),
          ),
        )
        .get();
      if (prior) {
        return {
          pocket: prior.balancePocket,
          bank: prior.balanceBank,
          frozen: prior.balanceFrozen,
        };
      }
    }

    if (opts?.config && !opts.skipPauseCheck && isGuildPaused(mutation.guildId, opts.config)) {
      throw new EconomyError("The economy is paused.", "paused");
    }

    const profile = ensureProfile(mutation.guildId, mutation.userId);
    if (profile.frozen && !mutation.allowFrozenAccount) {
      throw new EconomyError("This economy account is frozen.", "frozen");
    }

    ensureAccountRow(mutation.guildId, mutation.userId, mutation.currencyKey);
    const account = tx
      .select()
      .from(economyAccounts)
      .where(
        and(
          eq(economyAccounts.guildId, mutation.guildId),
          eq(economyAccounts.userId, mutation.userId),
          eq(economyAccounts.currencyKey, mutation.currencyKey),
        ),
      )
      .get()!;

    const nextPocket = account.pocket + deltaPocket;
    const nextBank = account.bank + deltaBank;
    const nextFrozen = account.frozen + deltaFrozen;
    if (nextPocket < 0 || nextBank < 0 || nextFrozen < 0) {
      throw new EconomyError("Insufficient funds.", "insufficient");
    }

    tx.update(economyAccounts)
      .set({
        pocket: nextPocket,
        bank: nextBank,
        frozen: nextFrozen,
        updatedAt: now(),
      })
      .where(
        and(
          eq(economyAccounts.guildId, mutation.guildId),
          eq(economyAccounts.userId, mutation.userId),
          eq(economyAccounts.currencyKey, mutation.currencyKey),
        ),
      )
      .run();

    tx.insert(economyTransactions)
      .values({
        guildId: mutation.guildId,
        userId: mutation.userId,
        currencyKey: mutation.currencyKey,
        deltaPocket,
        deltaBank,
        deltaFrozen,
        balancePocket: nextPocket,
        balanceBank: nextBank,
        balanceFrozen: nextFrozen,
        reason: mutation.reason,
        actorId: mutation.actorId ?? null,
        refType: mutation.refType ?? null,
        refId: mutation.refId ?? null,
        idempotencyKey: mutation.idempotencyKey ?? null,
        metaJson: JSON.stringify(mutation.meta ?? {}),
        createdAt: now(),
      })
      .run();

    const net = deltaPocket + deltaBank + deltaFrozen;
    if (mutation.reason.startsWith("admin_")) {
      bumpDailyStats(mutation.guildId, { adminAdjust: Math.abs(net) });
    } else if (net > 0) {
      bumpDailyStats(mutation.guildId, { minted: net });
    } else if (net < 0) {
      bumpDailyStats(mutation.guildId, { sunk: -net });
    }
    if (mutation.reason === "transfer" || mutation.reason === "transfer_tax") {
      bumpDailyStats(mutation.guildId, { transfers: 1 });
    }
    if (mutation.reason === "shop_buy") {
      bumpDailyStats(mutation.guildId, { shopRevenue: Math.abs(deltaPocket) });
    }
    if (mutation.reason.startsWith("market_") || mutation.reason.startsWith("auction_")) {
      bumpDailyStats(mutation.guildId, { marketVolume: Math.abs(deltaPocket + deltaFrozen) });
    }

    return { pocket: nextPocket, bank: nextBank, frozen: nextFrozen };
  });
}

export function grantStartingBalance(guildId: string, userId: string, config: EconomyConfig) {
  ensureGuildCurrencies(guildId, config);
  ensureProfile(guildId, userId);
  const primary = getPrimaryCurrencyKey(guildId, config);
  const account = getAccount(guildId, userId, primary);
  const gems = getAccount(guildId, userId, "gems");
  const touched =
    account.pocket + account.bank + account.frozen + gems.pocket + gems.bank + gems.frozen > 0;
  if (touched) return;

  if (config.starting_balance > 0) {
    mutateMoney(
      {
        guildId,
        userId,
        currencyKey: primary,
        deltaPocket: config.starting_balance,
        reason: "starting_balance",
        idempotencyKey: `start:${guildId}:${userId}:${primary}`,
      },
      { config, skipPauseCheck: true },
    );
  }
  if (config.starting_secondary > 0) {
    mutateMoney(
      {
        guildId,
        userId,
        currencyKey: "gems",
        deltaPocket: config.starting_secondary,
        reason: "starting_balance",
        idempotencyKey: `start:${guildId}:${userId}:gems`,
      },
      { config, skipPauseCheck: true },
    );
  }
}

export function transferBetweenUsers(opts: {
  guildId: string;
  fromUserId: string;
  toUserId: string;
  currencyKey: string;
  amount: number;
  config: EconomyConfig;
  actorId: string;
  idempotencyKey?: string;
}): { from: AccountBalances; to: AccountBalances; tax: number } {
  const { config } = opts;
  if (!config.transfers.enabled) throw new EconomyError("Transfers are disabled.", "invalid");
  if (opts.fromUserId === opts.toUserId) throw new EconomyError("You cannot pay yourself.", "invalid");
  if (opts.amount < config.transfers.min_amount) {
    throw new EconomyError(`Minimum transfer is ${config.transfers.min_amount}.`, "limit");
  }
  if (config.transfers.max_amount > 0 && opts.amount > config.transfers.max_amount) {
    throw new EconomyError(`Maximum transfer is ${config.transfers.max_amount}.`, "limit");
  }

  const tax = applyBps(opts.amount, config.transfers.tax_bps);
  const net = opts.amount - tax;
  if (net <= 0) throw new EconomyError("Transfer amount too small after tax.", "invalid");

  const db = getDb();
  return db.transaction(() => {
    const from = mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.fromUserId,
        currencyKey: opts.currencyKey,
        deltaPocket: -opts.amount,
        reason: "transfer",
        actorId: opts.actorId,
        refType: "user",
        refId: opts.toUserId,
        idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:from` : null,
        meta: { to: opts.toUserId, gross: opts.amount, tax, net },
      },
      { config },
    );
    if (tax > 0) {
      // Tax is already removed from sender; record sink via stats (net negative already counted).
      bumpDailyStats(opts.guildId, { sunk: 0 });
    }
    const to = mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.toUserId,
        currencyKey: opts.currencyKey,
        deltaPocket: net,
        reason: "transfer",
        actorId: opts.actorId,
        refType: "user",
        refId: opts.fromUserId,
        idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:to` : null,
        meta: { from: opts.fromUserId, gross: opts.amount, tax, net },
      },
      { config },
    );
    return { from, to, tax };
  });
}

export function depositToBank(opts: {
  guildId: string;
  userId: string;
  currencyKey: string;
  amount: number;
  config: EconomyConfig;
}): AccountBalances {
  if (!opts.config.modules.banking || !opts.config.bank.enabled) {
    throw new EconomyError("Banking is disabled.", "invalid");
  }
  if (opts.amount <= 0) throw new EconomyError("Amount must be positive.", "invalid");
  const fee = applyBps(opts.amount, opts.config.bank.deposit_fee_bps);
  const credited = opts.amount - fee;
  if (credited <= 0) throw new EconomyError("Amount too small after fee.", "invalid");

  if (opts.config.bank.max_balance > 0) {
    const current = getAccount(opts.guildId, opts.userId, opts.currencyKey);
    if (current.bank + credited > opts.config.bank.max_balance) {
      throw new EconomyError("Bank capacity exceeded.", "limit");
    }
  }

  return mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey: opts.currencyKey,
      deltaPocket: -opts.amount,
      deltaBank: credited,
      reason: "bank_deposit",
      meta: { fee, credited },
    },
    { config: opts.config },
  );
}

export function withdrawFromBank(opts: {
  guildId: string;
  userId: string;
  currencyKey: string;
  amount: number;
  config: EconomyConfig;
}): AccountBalances {
  if (!opts.config.modules.banking || !opts.config.bank.enabled) {
    throw new EconomyError("Banking is disabled.", "invalid");
  }
  if (opts.amount <= 0) throw new EconomyError("Amount must be positive.", "invalid");
  const fee = applyBps(opts.amount, opts.config.bank.withdraw_fee_bps);
  const credited = opts.amount - fee;
  if (credited <= 0) throw new EconomyError("Amount too small after fee.", "invalid");

  return mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey: opts.currencyKey,
      deltaBank: -opts.amount,
      deltaPocket: credited,
      reason: "bank_withdraw",
      meta: { fee, credited },
    },
    { config: opts.config },
  );
}

export function freezeToEscrow(opts: {
  guildId: string;
  userId: string;
  currencyKey: string;
  amount: number;
  reason: string;
  config: EconomyConfig;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}): AccountBalances {
  if (opts.amount <= 0) throw new EconomyError("Amount must be positive.", "invalid");
  return mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey: opts.currencyKey,
      deltaPocket: -opts.amount,
      deltaFrozen: opts.amount,
      reason: opts.reason,
      refType: opts.refType,
      refId: opts.refId,
      idempotencyKey: opts.idempotencyKey,
    },
    { config: opts.config },
  );
}

export function releaseEscrow(opts: {
  guildId: string;
  userId: string;
  currencyKey: string;
  amount: number;
  to: "pocket" | "sink" | "other";
  otherUserId?: string;
  reason: string;
  config: EconomyConfig;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
}): void {
  if (opts.amount <= 0) throw new EconomyError("Amount must be positive.", "invalid");
  const db = getDb();
  db.transaction(() => {
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey: opts.currencyKey,
        deltaFrozen: -opts.amount,
        deltaPocket: opts.to === "pocket" ? opts.amount : 0,
        reason: opts.reason,
        refType: opts.refType,
        refId: opts.refId,
        idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:release` : null,
        allowFrozenAccount: true,
      },
      { config: opts.config, skipPauseCheck: true },
    );
    if (opts.to === "other") {
      if (!opts.otherUserId) throw new EconomyError("Missing recipient.", "invalid");
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: opts.otherUserId,
          currencyKey: opts.currencyKey,
          deltaPocket: opts.amount,
          reason: opts.reason,
          refType: opts.refType,
          refId: opts.refId,
          idempotencyKey: opts.idempotencyKey ? `${opts.idempotencyKey}:credit` : null,
          allowFrozenAccount: true,
        },
        { config: opts.config, skipPauseCheck: true },
      );
    }
  });
}

export function adminAdjust(opts: {
  guildId: string;
  userId: string;
  currencyKey: string;
  pocketDelta?: number;
  bankDelta?: number;
  mode: "add" | "take" | "set";
  actorId: string;
  config: EconomyConfig;
  reason?: string;
}): AccountBalances {
  ensureProfile(opts.guildId, opts.userId);
  const current = getAccount(opts.guildId, opts.userId, opts.currencyKey);
  let deltaPocket = opts.pocketDelta ?? 0;
  let deltaBank = opts.bankDelta ?? 0;
  if (opts.mode === "set") {
    if (opts.pocketDelta !== undefined) deltaPocket = opts.pocketDelta - current.pocket;
    if (opts.bankDelta !== undefined) deltaBank = opts.bankDelta - current.bank;
  } else if (opts.mode === "take") {
    deltaPocket = -Math.abs(deltaPocket);
    deltaBank = -Math.abs(deltaBank);
  }
  return mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey: opts.currencyKey,
      deltaPocket,
      deltaBank,
      reason: opts.reason ?? `admin_${opts.mode}`,
      actorId: opts.actorId,
      allowFrozenAccount: true,
    },
    { config: opts.config, skipPauseCheck: true },
  );
}

export function setAccountFrozen(
  guildId: string,
  userId: string,
  frozen: boolean,
  reason?: string,
) {
  ensureProfile(guildId, userId);
  getDb()
    .update(economyProfiles)
    .set({
      frozen,
      freezeReason: frozen ? reason ?? "Frozen by staff" : null,
      updatedAt: now(),
    })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
}

export function listTransactions(guildId: string, userId: string, limit = 10) {
  return getDb()
    .select()
    .from(economyTransactions)
    .where(and(eq(economyTransactions.guildId, guildId), eq(economyTransactions.userId, userId)))
    .orderBy(sql`${economyTransactions.id} DESC`)
    .limit(Math.min(Math.max(limit, 1), 50))
    .all();
}

export function getNetWorth(guildId: string, userId: string, currencyKey: string): number {
  const a = getAccount(guildId, userId, currencyKey);
  return a.pocket + a.bank + a.frozen;
}

export function leaderboardRichest(guildId: string, currencyKey: string, limit = 10) {
  return getDb()
    .select({
      userId: economyAccounts.userId,
      total: sql<number>`${economyAccounts.pocket} + ${economyAccounts.bank} + ${economyAccounts.frozen}`,
      pocket: economyAccounts.pocket,
      bank: economyAccounts.bank,
    })
    .from(economyAccounts)
    .where(and(eq(economyAccounts.guildId, guildId), eq(economyAccounts.currencyKey, currencyKey)))
    .orderBy(sql`(${economyAccounts.pocket} + ${economyAccounts.bank} + ${economyAccounts.frozen}) DESC`)
    .limit(Math.min(Math.max(limit, 1), 25))
    .all();
}

export function addXp(guildId: string, userId: string, amount: number, config: EconomyConfig) {
  if (amount <= 0) return ensureProfile(guildId, userId);
  const profile = ensureProfile(guildId, userId);
  let xp = profile.xp + amount;
  let level = profile.level;
  let need = Math.floor(
    config.progression.level_curve_base * Math.pow(config.progression.level_curve_factor, level - 1),
  );
  while (xp >= need && level < 10_000) {
    xp -= need;
    level += 1;
    need = Math.floor(
      config.progression.level_curve_base * Math.pow(config.progression.level_curve_factor, level - 1),
    );
  }
  getDb()
    .update(economyProfiles)
    .set({ xp, level, updatedAt: now() })
    .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
    .run();
  return { ...profile, xp, level };
}
