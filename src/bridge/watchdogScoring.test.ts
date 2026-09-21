import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WATCHDOG_SIGNAL_CATEGORIES,
  convergenceBonus,
  decayWeight,
  scoreAccountAge,
  scoreDuplicateContent,
  scoreJoinBurst,
  scoreJoinGap,
  scoreKeywordHits,
  scoreModCases,
  scoreOpenIncident,
  scoreStrikes,
  scoreUsername,
  tierFor,
} from "./watchdogScoring.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("watchdog tiers", () => {
  it("buckets scores into the right tier", () => {
    assert.equal(tierFor(0), "low");
    assert.equal(tierFor(24), "low");
    assert.equal(tierFor(25), "watch");
    assert.equal(tierFor(49), "watch");
    assert.equal(tierFor(50), "elevated");
    assert.equal(tierFor(74), "elevated");
    assert.equal(tierFor(75), "critical");
    assert.equal(tierFor(100), "critical");
  });
});

describe("account age signal", () => {
  const now = Date.now();

  it("flags brand-new accounts heavily", () => {
    const reason = scoreAccountAge(now - 2 * 60 * 60 * 1000, now);
    assert.ok(reason);
    assert.equal(reason!.points, 30);
  });

  it("decays as the account gets older", () => {
    assert.equal(scoreAccountAge(now - 3 * DAY_MS, now)!.points, 22);
    assert.equal(scoreAccountAge(now - 15 * DAY_MS, now)!.points, 12);
    assert.equal(scoreAccountAge(now - 100 * DAY_MS, now)!.points, 5);
  });

  it("clears once the account is well established", () => {
    assert.equal(scoreAccountAge(now - 200 * DAY_MS, now), null);
  });
});

describe("join gap signal", () => {
  const created = Date.parse("2024-01-01T00:00:00Z");

  it("flags joining immediately after account creation", () => {
    const reason = scoreJoinGap(created, created + 10 * 60 * 1000);
    assert.ok(reason);
    assert.equal(reason!.points, 20);
  });

  it("is lighter for a same-day but not immediate join", () => {
    const reason = scoreJoinGap(created, created + 5 * 60 * 60 * 1000);
    assert.equal(reason!.points, 10);
  });

  it("clears for an account that existed a while before joining", () => {
    assert.equal(scoreJoinGap(created, created + 5 * DAY_MS), null);
  });

  it("is null with no join timestamp", () => {
    assert.equal(scoreJoinGap(created, null), null);
  });
});

describe("username heuristic", () => {
  it("flags bulk-generated-looking handles", () => {
    assert.ok(scoreUsername("user8271"));
    assert.ok(scoreUsername("xj4k29931"));
  });

  it("does not flag ordinary handles", () => {
    assert.equal(scoreUsername("player1"), null);
    assert.equal(scoreUsername("cool_guy22"), null);
    assert.equal(scoreUsername("ryan"), null);
  });
});

describe("decay curve", () => {
  it("is full weight up to the full-weight day", () => {
    assert.equal(decayWeight(0, 7, 30, 40), 1);
    assert.equal(decayWeight(7, 7, 30, 40), 1);
  });

  it("tapers linearly between the full-weight day and the floor day", () => {
    // halfway between day 7 and day 30 (floor 40%) should be halfway between 100% and 40%
    const midDay = 7 + (30 - 7) / 2;
    const mid = decayWeight(midDay, 7, 30, 40);
    assert.ok(Math.abs(mid - 0.7) < 1e-9);
  });

  it("clamps to the floor at and beyond the floor day", () => {
    assert.equal(decayWeight(30, 7, 30, 40), 0.4);
    assert.equal(decayWeight(365, 7, 30, 40), 0.4);
  });
});

describe("automod-hits signal (fixed from the dead modStrikes read)", () => {
  const now = Date.now();

  it("is null with no hits", () => {
    assert.equal(scoreStrikes([], now), null);
  });

  it("scores recent hits near full weight, capped at the automod_hit_cap default", () => {
    const hits = Array.from({ length: 10 }, () => ({ createdAt: now - 1 * DAY_MS }));
    const reason = scoreStrikes(hits, now);
    assert.ok(reason);
    assert.equal(reason!.points, 35); // capped
    assert.match(reason!.label, /10 automod hits in the last 30 days/);
  });

  it("weighs a single recent hit at close to its full per-hit value", () => {
    const reason = scoreStrikes([{ createdAt: now - 1 * DAY_MS }], now);
    assert.ok(reason);
    assert.equal(reason!.points, 12);
  });

  it("tapers older hits toward the 30-day floor", () => {
    const recent = scoreStrikes([{ createdAt: now - 1 * DAY_MS }], now)!.points;
    const old = scoreStrikes([{ createdAt: now - 29 * DAY_MS }], now)!.points;
    assert.ok(old < recent);
  });
});

describe("mod-case signal (decay-weighted)", () => {
  const now = Date.now();

  it("is null with no cases", () => {
    assert.equal(scoreModCases([], now), null);
  });

  it("weighs a recent active case heavier than a recent resolved one", () => {
    const activeOnly = scoreModCases([{ active: true, createdAt: now - 1 * DAY_MS }], now)!.points;
    const resolvedOnly = scoreModCases([{ active: false, createdAt: now - 1 * DAY_MS }], now)!.points;
    assert.ok(activeOnly > resolvedOnly);
  });

  it("weighs a very old case much lighter than a recent one of the same kind", () => {
    const recent = scoreModCases([{ active: false, createdAt: now - 1 * DAY_MS }], now)!.points;
    const old = scoreModCases([{ active: false, createdAt: now - 400 * DAY_MS }], now)!.points;
    assert.ok(old > 0);
    assert.ok(old < recent);
  });

  it("labels using case counts, not the decayed point total", () => {
    const cases = [
      { active: true, createdAt: now - 1 * DAY_MS },
      { active: false, createdAt: now - 2 * DAY_MS },
    ];
    const reason = scoreModCases(cases, now)!;
    assert.match(reason.label, /1 active moderation case \(2 total\)/);
  });
});

describe("open incident signal", () => {
  it("is null when there is no open incident", () => {
    assert.equal(scoreOpenIncident(false), null);
  });

  it("flags a flat bonus when there is an open incident", () => {
    const reason = scoreOpenIncident(true);
    assert.ok(reason);
    assert.equal(reason!.points, 18);
  });
});

describe("join burst signal", () => {
  const joinedAt = Date.parse("2024-01-01T00:00:00Z");

  it("flags a heavy burst right after joining", () => {
    const trail = [{ startedAt: new Date(joinedAt + 60_000), messageCount: 20 }];
    assert.equal(scoreJoinBurst(joinedAt, trail)!.points, 25);
  });

  it("ignores messages sent long after joining", () => {
    const trail = [{ startedAt: new Date(joinedAt + 2 * DAY_MS), messageCount: 20 }];
    assert.equal(scoreJoinBurst(joinedAt, trail), null);
  });
});

describe("duplicate content signal", () => {
  it("flags the same text posted across channels", () => {
    const trail = [
      { channelId: "a", snippet: "check out this free nitro giveaway now" },
      { channelId: "b", snippet: "check out this free nitro giveaway now" },
      { channelId: "c", snippet: "check out this free nitro giveaway now" },
    ];
    assert.equal(scoreDuplicateContent(trail)!.points, 22);
  });

  it("does not flag distinct conversation", () => {
    const trail = [
      { channelId: "a", snippet: "hey how's it going" },
      { channelId: "b", snippet: "anyone up for a game later" },
    ];
    assert.equal(scoreDuplicateContent(trail), null);
  });
});

describe("keyword content signals", () => {
  it("catches scam phrasing", () => {
    const { scam } = scoreKeywordHits([{ snippet: "yo everyone check my bio for free nitro" }]);
    assert.ok(scam);
  });

  it("weighs several distinct profane words heavier than a single mild hit", () => {
    // matchWordPack dedupes by distinct word (not occurrence count), so this
    // needs 3+ different words to cross the "repeated" threshold.
    const heavy = scoreKeywordHits([{ snippet: "shit ass bastard bitch" }]).profanity;
    assert.ok(heavy);
    assert.equal(heavy!.points, 15);

    const mild = scoreKeywordHits([{ snippet: "shit happens sometimes" }]).profanity;
    assert.ok(mild);
    assert.equal(mild!.points, 6);
  });

  it("is silent for clean text", () => {
    const { scam, profanity } = scoreKeywordHits([{ snippet: "excited for the event this weekend" }]);
    assert.equal(scam, null);
    assert.equal(profanity, null);
  });
});

describe("convergence bonus", () => {
  it("is null with 0 or 1 contributing categories", () => {
    assert.equal(convergenceBonus(0), null);
    assert.equal(convergenceBonus(1), null);
  });

  it("awards the 2-category bonus for exactly 2 categories", () => {
    assert.equal(convergenceBonus(2)!.points, 15);
  });

  it("awards the larger 3+-category bonus for 3 or more categories", () => {
    assert.equal(convergenceBonus(3)!.points, 20);
    assert.equal(convergenceBonus(4)!.points, 20);
  });

  it("keeps the bonus modest relative to the strongest individual signals", () => {
    const strongestSingleSignal = 30; // scoreAccountAge's brand-new-account points
    assert.ok(convergenceBonus(2)!.points < strongestSingleSignal);
    assert.ok(convergenceBonus(3)!.points < strongestSingleSignal);
  });
});

describe("signal categories", () => {
  it("covers every signal key with one of the four categories", () => {
    const categories = new Set(Object.values(WATCHDOG_SIGNAL_CATEGORIES));
    assert.deepEqual([...categories].sort(), ["behavior", "history", "identity", "standing"]);
  });

  it("groups history signals together (strikes, mod cases, open incident)", () => {
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.strikes, "history");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.modCases, "history");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.openIncident, "history");
  });

  it("groups identity signals together (account age, join gap, avatar, username, roles)", () => {
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.accountAge, "identity");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.joinGap, "identity");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.avatar, "identity");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.username, "identity");
    assert.equal(WATCHDOG_SIGNAL_CATEGORIES.roles, "identity");
  });
});
