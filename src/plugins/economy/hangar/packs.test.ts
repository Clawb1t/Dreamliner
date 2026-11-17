import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PACKS, LIVERIES, RARITIES, rarityIndex, type Livery, type Rarity } from "./constants.js";
import { drawRarity, normalizedOdds, pickCard, planPulls, rollLivery, type PoolCard } from "./packs.js";
import { seededRng } from "./random.js";

/** Three cards in every rarity, unlimited print runs. */
function fullPool(): PoolCard[] {
  let id = 1;
  return RARITIES.flatMap((rarity) => [0, 1, 2].map(() => ({ id: id++, rarity, remaining: null })));
}

/** Allowed deviation for a proportion: 5 standard errors plus a little slack. */
function tolerance(p: number, n: number): number {
  return 5 * Math.sqrt((p * (1 - p)) / n) + 0.0005;
}

describe("rarity-first draw odds", () => {
  for (const seed of DEFAULT_PACKS) {
    it(`matches the configured odds over 100k pulls (${seed.name})`, () => {
      const rng = seededRng(1000 + seed.price);
      const pool = fullPool();
      const n = 100_000;
      const counts = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<Rarity, number>;
      // Size-1 packs with no guarantee or pity: every pull is a natural draw.
      for (let i = 0; i < n; i++) {
        const { pulls } = planPulls({ ...seed, size: 1, guaranteeRarity: null, pityRarity: null, pityAfter: null }, pool, 0, rng);
        counts[pulls[0]!.rarity]++;
      }
      const expected = normalizedOdds(seed.rarityOdds);
      for (const r of RARITIES) {
        const actual = counts[r] / n;
        assert.ok(Math.abs(actual - expected[r]) <= tolerance(expected[r], n), `${seed.name} ${r}: ${actual} vs ${expected[r]}`);
      }
    });
  }

  it("ignores how many cards a rarity has (the catalog mix doesn't skew the odds)", () => {
    const rng = seededRng(7);
    // 20 rare cards and 1 legendary: rare must still come out at its configured share.
    const pool: PoolCard[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, rarity: "rare" as Rarity, remaining: null })),
      { id: 100, rarity: "legendary", remaining: null },
    ];
    const odds = { common: 0, uncommon: 0, rare: 50, epic: 0, legendary: 50, mythic: 0 };
    let rare = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (pickCard(drawRarity(odds, rng), pool, rng)!.rarity === "rare") rare++;
    assert.ok(Math.abs(rare / n - 0.5) <= tolerance(0.5, n));
  });

  it("falls back to the nearest rarity below, then above, when one is empty", () => {
    const rng = seededRng(3);
    const pool: PoolCard[] = [
      { id: 1, rarity: "uncommon", remaining: null },
      { id: 2, rarity: "legendary", remaining: null },
    ];
    assert.equal(pickCard("epic", pool, rng)!.rarity, "uncommon");
    assert.equal(pickCard("rare", pool, rng)!.rarity, "uncommon");
    assert.equal(pickCard("common", pool, rng)!.rarity, "uncommon");
    // Never below the guarantee floor: goes up instead.
    assert.equal(pickCard("epic", pool, rng, "epic")!.rarity, "legendary");
    assert.equal(pickCard("rare", [], rng), null);
  });
});

describe("guarantee and pity", () => {
  it("every Business pack has at least one Uncommon or better", () => {
    const rng = seededRng(11);
    const business = DEFAULT_PACKS.find((p) => p.key === "business")!;
    const pool = fullPool();
    for (let i = 0; i < 20_000; i++) {
      const { pulls } = planPulls(business, pool, 0, rng);
      assert.equal(pulls.length, 5);
      assert.ok(pulls.some((p) => rarityIndex(p.rarity) >= rarityIndex("uncommon")));
    }
  });

  it("every First Class pack has at least one Rare or better", () => {
    const rng = seededRng(12);
    const first = DEFAULT_PACKS.find((p) => p.key === "first_class")!;
    const pool = fullPool();
    let pity = 0;
    for (let i = 0; i < 20_000; i++) {
      const plan = planPulls(first, pool, pity, rng);
      pity = plan.pityCount;
      assert.ok(plan.pulls.some((p) => rarityIndex(p.rarity) >= rarityIndex("rare")));
    }
  });

  it("guarantees a Legendary or better within pityAfter cards, carried across packs", () => {
    const rng = seededRng(13);
    // Legendary nearly impossible naturally, so pity does the work.
    const pack = {
      size: 5,
      rarityOdds: { common: 90, uncommon: 9.999, rare: 0, epic: 0, legendary: 0.001, mythic: 0 },
      liveryOdds: { standard: 1, gold: 0, prototype: 0 },
      guaranteeRarity: null,
      pityRarity: "legendary" as Rarity,
      pityAfter: 12,
    };
    const pool = fullPool();
    let pity = 0;
    let gap = 0;
    let maxGap = 0;
    let forced = 0;
    for (let i = 0; i < 5000; i++) {
      const plan = planPulls(pack, pool, pity, rng);
      pity = plan.pityCount;
      for (const pull of plan.pulls) {
        gap++;
        if (pull.forced === "pity") forced++;
        if (rarityIndex(pull.rarity) >= rarityIndex("legendary")) {
          maxGap = Math.max(maxGap, gap);
          gap = 0;
        }
      }
    }
    assert.ok(maxGap <= 12, `gap ${maxGap}`);
    assert.ok(forced > 0);
  });

  it("resets the pity counter when a Legendary drops naturally", () => {
    const rng = seededRng(14);
    const pack = {
      size: 1,
      rarityOdds: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 1, mythic: 0 },
      liveryOdds: { standard: 1, gold: 0, prototype: 0 },
      guaranteeRarity: null,
      pityRarity: "legendary" as Rarity,
      pityAfter: 40,
    };
    const plan = planPulls(pack, fullPool(), 25, rng);
    assert.equal(plan.pityCount, 0);
    assert.equal(plan.pulls[0]!.forced, null);
  });
});

describe("print runs", () => {
  it("never draws a card past its remaining prints and falls back once it runs out", () => {
    const rng = seededRng(21);
    const pool: PoolCard[] = [
      { id: 1, rarity: "legendary", remaining: 2 },
      { id: 2, rarity: "epic", remaining: null },
    ];
    const pack = {
      size: 5,
      rarityOdds: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 1, mythic: 0 },
      liveryOdds: { standard: 1, gold: 0, prototype: 0 },
      guaranteeRarity: null,
      pityRarity: null,
      pityAfter: null,
    };
    const { pulls } = planPulls(pack, pool, 0, rng);
    assert.equal(pulls.filter((p) => p.cardTypeId === 1).length, 2);
    assert.equal(pulls.filter((p) => p.cardTypeId === 2).length, 3);
    assert.equal(pool[0]!.remaining, 0);
    // A second pack can't mint it at all.
    const again = planPulls(pack, pool, 0, rng);
    assert.ok(again.pulls.every((p) => p.cardTypeId === 2));
  });

  it("throws when nothing at all is left", () => {
    const pack = { size: 1, rarityOdds: { common: 1, uncommon: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 }, liveryOdds: { standard: 1, gold: 0, prototype: 0 }, guaranteeRarity: null, pityRarity: null, pityAfter: null };
    assert.throws(() => planPulls(pack, [{ id: 1, rarity: "common", remaining: 0 }], 0, seededRng(1)), /No cards/);
  });
});

describe("livery rolls", () => {
  for (const odds of [DEFAULT_PACKS[0]!.liveryOdds, DEFAULT_PACKS[2]!.liveryOdds]) {
    it(`match ${JSON.stringify(odds)} over 100k rolls`, () => {
      const rng = seededRng(31);
      const n = 100_000;
      const counts = Object.fromEntries(LIVERIES.map((l) => [l, 0])) as Record<Livery, number>;
      for (let i = 0; i < n; i++) counts[rollLivery(odds, rng)]++;
      const expected = normalizedOdds(odds);
      for (const l of LIVERIES) {
        assert.ok(Math.abs(counts[l] / n - expected[l]) <= tolerance(expected[l], n), `${l}: ${counts[l] / n} vs ${expected[l]}`);
      }
    });
  }
});
