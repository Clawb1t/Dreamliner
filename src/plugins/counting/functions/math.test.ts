import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeEvaluateExpression } from "./math.js";

describe("counting math evaluator", () => {
  it("parses plain integers", () => {
    assert.equal(safeEvaluateExpression("42"), 42);
    assert.equal(safeEvaluateExpression("-7"), -7);
  });

  it("evaluates arithmetic in the right order", () => {
    assert.equal(safeEvaluateExpression("12+3"), 15);
    assert.equal(safeEvaluateExpression("2+3*4"), 14);
    assert.equal(safeEvaluateExpression("(2+3)*4"), 20);
    assert.equal(safeEvaluateExpression("10/2-1"), 4);
  });

  it("rejects division by zero", () => {
    assert.equal(safeEvaluateExpression("5/0"), null);
  });

  it("rejects empty, malformed, or trailing-garbage input", () => {
    assert.equal(safeEvaluateExpression(""), null);
    assert.equal(safeEvaluateExpression("   "), null);
    assert.equal(safeEvaluateExpression("1+"), null);
    assert.equal(safeEvaluateExpression("1 2"), null);
    assert.equal(safeEvaluateExpression("1+1)"), null);
    assert.equal(safeEvaluateExpression("((1+1)"), null);
  });

  it("rejects non-arithmetic content, including attempted injection", () => {
    assert.equal(safeEvaluateExpression("1; process.exit(1)"), null);
    assert.equal(safeEvaluateExpression("one plus one"), null);
    assert.equal(safeEvaluateExpression("1e10"), null);
  });
});
