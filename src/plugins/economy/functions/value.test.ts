import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RARITY_SELL_VALUE, rollSellPrice } from "./value.js";
import { RARITY_ORDER } from "./catalog.js";

describe("plane card sell value", () => {
  it("rolls within ±20% of the rarity's base value for every rarity", () => {
    for (const rarity of RARITY_ORDER) {
      const base = RARITY_SELL_VALUE[rarity];
      for (let i = 0; i < 200; i++) {
        const price = rollSellPrice(rarity);
        assert.ok(price >= base * 0.8 - 0.01, `${rarity} rolled ${price}, below ${base * 0.8}`);
        assert.ok(price <= base * 1.2 + 0.01, `${rarity} rolled ${price}, above ${base * 1.2}`);
      }
    }
  });

  it("never sells for more than legendary's base value, even for legendary itself", () => {
    for (let i = 0; i < 200; i++) {
      assert.ok(rollSellPrice("legendary") <= RARITY_SELL_VALUE.legendary);
    }
  });

  it("falls back to the lowest rarity's value for an unknown rarity", () => {
    const price = rollSellPrice("not-a-rarity");
    const base = RARITY_SELL_VALUE[RARITY_ORDER[0]];
    assert.ok(price >= base * 0.8 - 0.01 && price <= base * 1.2 + 0.01);
  });
});
