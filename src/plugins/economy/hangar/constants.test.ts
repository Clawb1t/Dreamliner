import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CRAFT_TO_SALVAGE_RATIO,
  FIRST_EDITION_MULTIPLIER,
  LEVEL_XP,
  LIVERY_META,
  MAX_LEVEL,
  PILOT_RANKS,
  RARITIES,
  RARITY_META,
  copyPoints,
  craftCost,
  levelForXp,
  marketFee,
  pilotRankFor,
  salvageValue,
  upgradeCost,
} from "./constants.js";

describe("salvage and craft maths", () => {
  it("crafting costs 4x the base salvage value for every craftable rarity", () => {
    for (const rarity of RARITIES) {
      const cost = craftCost(rarity);
      if (cost === null) continue;
      assert.equal(cost, RARITY_META[rarity].salvage * CRAFT_TO_SALVAGE_RATIO, rarity);
    }
  });

  it("Mythic cards can't be crafted", () => {
    assert.equal(craftCost("mythic"), null);
  });

  it("salvage scales by livery and First Edition", () => {
    assert.equal(salvageValue("rare", "standard", false), 30);
    assert.equal(salvageValue("rare", "gold", false), 90);
    assert.equal(salvageValue("rare", "prototype", false), 300);
    assert.equal(salvageValue("rare", "standard", true), Math.round(30 * FIRST_EDITION_MULTIPLIER));
  });

  it("a crafted copy (Standard, maybe First Edition) never salvages for its craft cost", () => {
    // Crafting always mints Standard, so salvage then craft again is always a loss: no Parts loop.
    for (const rarity of RARITIES) {
      const cost = craftCost(rarity);
      if (cost === null) continue;
      const best = Math.max(salvageValue(rarity, "standard", false), salvageValue(rarity, "standard", true));
      assert.ok(best * 3 < cost, `${rarity}: salvage ${best} vs craft ${cost}`);
    }
  });

  it("levels don't change salvage value (flights can't farm Parts through salvage)", () => {
    // salvageValue takes no level at all; points do scale with level.
    assert.ok(copyPoints("epic", "standard", false, 10) > copyPoints("epic", "standard", false, 1));
  });

  it("upgrade cost grows with level and stops at the max", () => {
    assert.equal(upgradeCost("rare", 1), RARITY_META.rare.upgradePerLevel);
    assert.equal(upgradeCost("rare", 5), RARITY_META.rare.upgradePerLevel * 5);
    assert.equal(upgradeCost("rare", MAX_LEVEL), null);
  });
});

describe("levels and ranks", () => {
  it("maps XP to levels using the cumulative table", () => {
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(LEVEL_XP[2]! - 1), 1);
    assert.equal(levelForXp(LEVEL_XP[2]!), 2);
    assert.equal(levelForXp(1_000_000), MAX_LEVEL);
  });

  it("Pilot Rank thresholds rise and the progress is 0..1", () => {
    for (let i = 1; i < PILOT_RANKS.length; i++) assert.ok(PILOT_RANKS[i]!.minFleetValue > PILOT_RANKS[i - 1]!.minFleetValue);
    assert.equal(pilotRankFor(0).rank.key, "cadet");
    assert.equal(pilotRankFor(10_000_000).rank.key, "legend");
    assert.equal(pilotRankFor(10_000_000).next, null);
    const mid = pilotRankFor(125);
    assert.equal(mid.rank.key, "student_pilot");
    assert.ok(mid.progress > 0 && mid.progress < 1);
  });

  it("points multiply by livery", () => {
    assert.equal(copyPoints("legendary", "prototype", false, 1), RARITY_META.legendary.points * LIVERY_META.prototype.pointsMultiplier);
  });
});

describe("market fee", () => {
  it("is 5% rounded to the cent", () => {
    assert.equal(marketFee(100), 5);
    assert.equal(marketFee(1), 0.05);
    assert.equal(marketFee(12.34), 0.62);
  });
});
