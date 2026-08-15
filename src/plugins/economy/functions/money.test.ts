import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBps, applyMultiplier, EconomyError } from "./money.js";
import { formatCurrency, shortEconomyError } from "./format.js";
import { zEconomyConfig } from "../../../config/schemas/economy.js";

describe("economy money helpers", () => {
  it("applies basis points fees", () => {
    assert.equal(applyBps(1000, 500), 50);
    assert.equal(applyBps(1000, 0), 0);
    assert.equal(applyBps(1, 1), 0);
  });

  it("applies reward multipliers", () => {
    assert.equal(applyMultiplier(100, 1000), 110);
    assert.equal(applyMultiplier(100, 0), 100);
  });
});

describe("economy format", () => {
  const config = zEconomyConfig.parse({});

  it("formats currency", () => {
    const text = formatCurrency(250, config, { currencyKey: "coins" });
    assert.match(text, /250/);
    assert.match(text, /Coin/);
  });

  it("maps EconomyError messages", () => {
    assert.equal(shortEconomyError(new EconomyError("Nope", "paused")), "Nope");
    assert.equal(shortEconomyError(new Error("boom")), "boom");
  });
});

describe("economy config schema", () => {
  it("parses defaults", () => {
    const cfg = zEconomyConfig.parse({});
    assert.equal(cfg.rewards.daily_amount, 250);
    assert.equal(cfg.modules.shop, true);
    assert.equal(cfg.paused, false);
    assert.equal(cfg.can_balance, false);
  });
});
