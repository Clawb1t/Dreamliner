import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStockCandles, classifyRSI, computeRSI, computeTradeImpact } from "./stocks.js";

describe("stock candles", () => {
  it("buckets a price series into OHLC candles", () => {
    const history = [1, 2, 3, 4, 1, 5, 6, 7].map((price, i) => ({ price, recordedAt: new Date(i * 60_000) }));
    const candles = buildStockCandles(history, 2);
    assert.equal(candles.length, 2);
    assert.equal(candles[0]!.open, 1);
    assert.equal(candles[0]!.close, 4);
    assert.equal(candles[0]!.high, 4);
    assert.equal(candles[0]!.low, 1);
    assert.equal(candles[1]!.open, 1);
    assert.equal(candles[1]!.close, 7);
  });

  it("returns nothing for empty history", () => {
    assert.deepEqual(buildStockCandles([]), []);
  });
});

describe("stock RSI", () => {
  it("returns null without enough history for a full period", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 10 + i);
    assert.equal(computeRSI(closes, 14), null);
  });

  it("reads 100 for a strictly rising series with no losses", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
    assert.equal(computeRSI(closes, 14), 100);
  });

  it("reads 0 for a strictly falling series with no gains", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    assert.equal(computeRSI(closes, 14), 0);
  });

  it("reads 50 for a flat series", () => {
    const closes = Array.from({ length: 20 }, () => 10);
    assert.equal(computeRSI(closes, 14), 50);
  });

  it("classifies overbought/oversold/neutral at the standard 70/30 thresholds", () => {
    assert.equal(classifyRSI(71), "overbought");
    assert.equal(classifyRSI(70), "overbought");
    assert.equal(classifyRSI(29), "oversold");
    assert.equal(classifyRSI(30), "oversold");
    assert.equal(classifyRSI(50), "neutral");
  });
});

describe("stock trade impact", () => {
  it("is zero for a non-positive price or trade value", () => {
    assert.equal(computeTradeImpact(0, 100), 0);
    assert.equal(computeTradeImpact(10, 0), 0);
    assert.equal(computeTradeImpact(10, -5), 0);
  });

  it("grows with trade size but sub-linearly (square-root impact)", () => {
    const small = computeTradeImpact(10, 100);
    const large = computeTradeImpact(10, 400);
    assert.ok(large > small, "a 4x bigger trade should move the price more");
    assert.ok(large < small * 4, "impact should grow slower than trade size (square-root, not linear)");
  });

  it("moves a pricier stock less than a cheaper one for the same coin amount", () => {
    const cheap = computeTradeImpact(1, 500);
    const pricey = computeTradeImpact(1000, 500);
    assert.ok(cheap > pricey, "the same trade should move a $1 stock more than a $1000 stock");
  });

  it("never exceeds the hard per-trade cap, however large the trade", () => {
    assert.ok(computeTradeImpact(10, 10_000_000) <= 0.15);
  });
});
