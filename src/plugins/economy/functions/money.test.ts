import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { round2 } from "./money.js";
import { formatAmount, formatExchangeRate, formatGlobal, formatServer, GLOBAL_MESSAGE_AMOUNT } from "./format.js";
import { computeExchangeRate } from "./stocks.js";
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

  it("formats an exchange rate", () => {
    assert.equal(formatExchangeRate(1), "1.00x");
    assert.equal(formatExchangeRate(0.1), "0.10x");
  });
});

describe("economy exchange rate", () => {
  it("is 1x at the stock's starting price", () => {
    assert.equal(computeExchangeRate(10, 10), 1);
  });

  it("scales down for a stock trading below its base price", () => {
    assert.equal(computeExchangeRate(5, 10), 0.5);
  });

  it("scales up for a stock trading above its base price", () => {
    assert.equal(computeExchangeRate(20, 10), 2);
  });

  it("clamps to a minimum rate for a cratered stock", () => {
    assert.equal(computeExchangeRate(0.5, 10), 0.1);
  });

  it("clamps to a maximum rate for a runaway stock", () => {
    assert.equal(computeExchangeRate(1000, 10), 3);
  });
});
