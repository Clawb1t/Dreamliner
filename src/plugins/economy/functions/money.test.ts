import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { round2 } from "./money.js";
import { formatAmount, formatGlobal, formatServer, GLOBAL_MESSAGE_AMOUNT } from "./format.js";
import { zEconomyConfig } from "../../../config/schemas/economy.js";

describe("economy money helpers", () => {
  it("rounds to 2 decimal places", () => {
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(1.005), 1);
    assert.equal(round2(0), 0);
  });
});

describe("economy format", () => {
  const config = zEconomyConfig.parse({});

  it("formats amounts to 2 decimals", () => {
    assert.equal(formatAmount(0.15), "0.15");
    assert.equal(formatAmount(5), "5.00");
  });

  it("formats the global currency", () => {
    const text = formatGlobal(GLOBAL_MESSAGE_AMOUNT);
    assert.match(text, /0\.15/);
    assert.match(text, /Coins/);
  });

  it("formats the server currency using configured name and symbol", () => {
    const text = formatServer(1, config.server);
    assert.match(text, /1\.00/);
    assert.match(text, /Coin/);
  });
});
