import { sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { round2 } from "../functions/money.js";
import { LIVERIES, RARITIES, isLivery, isRarity, type Livery, type Rarity } from "./constants.js";
import { COIN_BURN_KINDS, PARTS_EARN_KINDS, PARTS_SPEND_KINDS } from "./ledger.js";
import { listPacks, normalizedOdds } from "./packs.js";

export type DistributionRow<K extends string> = Record<K, { pulls: number; actual: number; expected: number }>;

export type PackHealth = {
  key: string;
  name: string;
  openings: number;
  /** Cards pulled without a guarantee or pity constraint (what the odds apply to). */
  naturalPulls: number;
  forcedPulls: number;
  rarity: DistributionRow<Rarity>;
  livery: DistributionRow<Livery>;
};

export type EconomyHealth = {
  since: string | null;
  coins: {
    burned: number;
    burnedByKind: Record<string, number>;
    transferred: number;
    transferredByKind: Record<string, number>;
    /** Sum of every card-system coin movement: always <= 0 (nothing mints coins). */
    netFlow: number;
  };
  parts: {
    issued: number;
    issuedByKind: Record<string, number>;
    spent: number;
    spentByKind: Record<string, number>;
    outstanding: number;
  };
  cards: { copies: number; owners: number; mintedByRarity: Record<Rarity, number>; mintedByLivery: Record<Livery, number> };
  market: { active: number; sold: number; volume: number; fees: number };
  trades: { pending: number; accepted: number };
  flights: { active: number; claimed: number };
  packs: PackHealth[];
};

type Pull = { rarity?: string; livery?: string; forced?: string | null };

function emptyDist<K extends string>(keys: readonly K[]): DistributionRow<K> {
  return Object.fromEntries(keys.map((k) => [k, { pulls: 0, actual: 0, expected: 0 }])) as DistributionRow<K>;
}

/** Superuser economy health: coins burned vs moved, Parts issued vs spent, pulls vs configured odds. */
export function economyHealth(opts: { sinceDays?: number | null } = {}): EconomyHealth {
  const db = getDb();
  const sinceSec = opts.sinceDays ? Math.floor(Date.now() / 1000) - Math.floor(opts.sinceDays * 86400) : 0;
  const since = opts.sinceDays ? new Date(sinceSec * 1000).toISOString() : null;

  const coinRows = db.all<{ kind: string; total: number }>(
    sql`SELECT kind, SUM(delta) AS total FROM plane_coin_ledger WHERE created_at >= ${sinceSec} GROUP BY kind`,
  );
  const burnedByKind: Record<string, number> = {};
  const transferredByKind: Record<string, number> = {};
  let netFlow = 0;
  for (const row of coinRows) {
    const total = Number(row.total) || 0;
    netFlow += total;
    if ((COIN_BURN_KINDS as readonly string[]).includes(row.kind)) burnedByKind[row.kind] = round2(-total);
    else if (total > 0) transferredByKind[row.kind] = round2(total);
  }

  const partsRows = db.all<{ kind: string; total: number }>(
    sql`SELECT kind, SUM(delta) AS total FROM plane_parts_ledger WHERE created_at >= ${sinceSec} GROUP BY kind`,
  );
  const issuedByKind: Record<string, number> = {};
  const spentByKind: Record<string, number> = {};
  for (const row of partsRows) {
    const total = Number(row.total) || 0;
    if ((PARTS_EARN_KINDS as readonly string[]).includes(row.kind)) issuedByKind[row.kind] = total;
    else if ((PARTS_SPEND_KINDS as readonly string[]).includes(row.kind)) spentByKind[row.kind] = -total;
  }
  const outstanding = Number(db.get<{ total: number }>(sql`SELECT COALESCE(SUM(delta), 0) AS total FROM plane_parts_ledger`)?.total ?? 0);

  const mintedByRarity = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<Rarity, number>;
  for (const row of db.all<{ rarity: string; n: number }>(
    sql`SELECT t.rarity AS rarity, COUNT(*) AS n FROM plane_card_copies c JOIN plane_card_types t ON t.id = c.card_type_id GROUP BY t.rarity`,
  )) {
    if (isRarity(row.rarity)) mintedByRarity[row.rarity] = Number(row.n);
  }
  const mintedByLivery = Object.fromEntries(LIVERIES.map((l) => [l, 0])) as Record<Livery, number>;
  for (const row of db.all<{ livery: string; n: number }>(sql`SELECT livery, COUNT(*) AS n FROM plane_card_copies GROUP BY livery`)) {
    if (isLivery(row.livery)) mintedByLivery[row.livery] = Number(row.n);
  }
  const copies = db.get<{ copies: number; owners: number }>(sql`SELECT COUNT(*) AS copies, COUNT(DISTINCT owner_id) AS owners FROM plane_card_copies`);

  const market = db.get<{ active: number; sold: number; volume: number; fees: number }>(sql`
    SELECT SUM(status = 'active') AS active, SUM(status = 'sold') AS sold,
      COALESCE(SUM(CASE WHEN status = 'sold' THEN price END), 0) AS volume,
      COALESCE(SUM(CASE WHEN status = 'sold' THEN fee END), 0) AS fees
    FROM plane_card_listings WHERE created_at >= ${sinceSec}`);
  const trades = db.get<{ pending: number; accepted: number }>(
    sql`SELECT SUM(status = 'pending') AS pending, SUM(status = 'accepted') AS accepted FROM plane_card_trades WHERE created_at >= ${sinceSec}`,
  );
  const flights = db.get<{ active: number; claimed: number }>(
    sql`SELECT SUM(claimed_at IS NULL) AS active, SUM(claimed_at IS NOT NULL) AS claimed FROM plane_card_flights WHERE started_at >= ${sinceSec}`,
  );

  // Pull distribution per pack, from the opening log (only post-Hangar rows carry `pulls`).
  const packs = listPacks();
  const openings = db.all<{ pack_key: string | null; pulls: string }>(
    sql`SELECT pack_key, pulls FROM plane_card_pack_openings WHERE source = 'pack' AND pack_key IS NOT NULL AND created_at >= ${sinceSec}`,
  );
  const packHealth: PackHealth[] = packs.map((pack) => {
    const rarity = emptyDist(RARITIES);
    const livery = emptyDist(LIVERIES);
    let natural = 0;
    let forced = 0;
    let count = 0;
    let liveryTotal = 0;
    for (const opening of openings) {
      if (opening.pack_key !== pack.key) continue;
      count++;
      let pulls: Pull[] = [];
      try {
        pulls = JSON.parse(opening.pulls) as Pull[];
      } catch {
        pulls = [];
      }
      for (const pull of pulls) {
        if (pull.livery && isLivery(pull.livery)) {
          livery[pull.livery].pulls++;
          liveryTotal++;
        }
        if (pull.forced) {
          forced++;
          continue;
        }
        if (pull.rarity && isRarity(pull.rarity)) {
          rarity[pull.rarity].pulls++;
          natural++;
        }
      }
    }
    const rarityExpected = normalizedOdds(pack.rarityOdds);
    const liveryExpected = normalizedOdds(pack.liveryOdds);
    for (const r of RARITIES) {
      rarity[r].expected = Math.round(rarityExpected[r] * 10000) / 10000;
      rarity[r].actual = natural ? Math.round((rarity[r].pulls / natural) * 10000) / 10000 : 0;
    }
    for (const l of LIVERIES) {
      livery[l].expected = Math.round(liveryExpected[l] * 10000) / 10000;
      livery[l].actual = liveryTotal ? Math.round((livery[l].pulls / liveryTotal) * 10000) / 10000 : 0;
    }
    return { key: pack.key, name: pack.name, openings: count, naturalPulls: natural, forcedPulls: forced, rarity, livery };
  });

  const sum = (o: Record<string, number>) => round2(Object.values(o).reduce((a, b) => a + b, 0));
  return {
    since,
    coins: {
      burned: sum(burnedByKind),
      burnedByKind,
      transferred: sum(transferredByKind),
      transferredByKind,
      netFlow: round2(netFlow),
    },
    parts: { issued: sum(issuedByKind), issuedByKind, spent: sum(spentByKind), spentByKind, outstanding },
    cards: { copies: Number(copies?.copies ?? 0), owners: Number(copies?.owners ?? 0), mintedByRarity, mintedByLivery },
    market: {
      active: Number(market?.active ?? 0),
      sold: Number(market?.sold ?? 0),
      volume: round2(Number(market?.volume ?? 0)),
      fees: round2(Number(market?.fees ?? 0)),
    },
    trades: { pending: Number(trades?.pending ?? 0), accepted: Number(trades?.accepted ?? 0) },
    flights: { active: Number(flights?.active ?? 0), claimed: Number(flights?.claimed ?? 0) },
    packs: packHealth,
  };
}
