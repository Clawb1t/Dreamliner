import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreAccountAge,
  scoreDuplicateContent,
  scoreJoinBurst,
  scoreJoinGap,
  scoreKeywordHits,
  scoreModCases,
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

describe("strikes and mod-case signals", () => {
  it("scales with strike count but caps out", () => {
    assert.equal(scoreStrikes(0), null);
    assert.equal(scoreStrikes(1)!.points, 12);
    assert.equal(scoreStrikes(10)!.points, 35);
  });

  it("weighs active cases heavier than resolved ones", () => {
    assert.equal(scoreModCases(0, 0), null);
    const activeOnly = scoreModCases(1, 1)!.points;
    const resolvedOnly = scoreModCases(0, 1)!.points;
    assert.ok(activeOnly > resolvedOnly);
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
