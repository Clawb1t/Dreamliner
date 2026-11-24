import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { backdropFill, dominantColor, easedRamp, formatProfileDate, formatVoiceMinutes, lastSeenLabel, layoutChips, renderProfileCard, snapshotAgeLabel, staticDecorationUrl, summarizeActivity } from "./profileCard.js";

test("the Activity card's numbers", () => {
  assert.equal(summarizeActivity([5], 30), null);
  const last = [0, 4, 10, 10, 0, 6];
  const summary = summarizeActivity([1, 1, 2, 2, 2, 2, ...last], 6)!;
  assert.deepEqual(summary.days, last);
  assert.equal(summary.total, 30);
  assert.equal(summary.average, 5);
  assert.equal(summary.activeDays, 4);
  assert.equal(summary.best, 10);
  assert.equal(summary.bestIndex, 3, "latest day wins a tie");
  assert.equal(summary.changePct, 200, "30 vs 10 the period before");
  // Not enough history, or a silent previous period: no comparison.
  assert.equal(summarizeActivity(last, 6)!.changePct, null);
  assert.equal(summarizeActivity([0, 0, 0, 0, 0, 0, ...last], 6)!.changePct, null);
});

test("the backdrop fill keeps the hue at one lightness, whatever the image", () => {
  const lightness = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };
  for (const color of ["#050510", "#ff3d7f", "#f6f1e7", "#808080"]) {
    assert.ok(Math.abs(lightness(backdropFill(color)) - 0.19) < 0.01, `${color} -> ${backdropFill(color)}`);
  }
  const red = backdropFill("#ff0000");
  assert.ok(parseInt(red.slice(1, 3), 16) > parseInt(red.slice(3, 5), 16) + 30, "keeps a red hue");
  assert.equal(backdropFill("#ffffff"), backdropFill("#000000"), "greys stay neutral");
});

test("eased ramps hold, then fall smoothly to zero", () => {
  const stops = easedRamp(0.3, 0.8);
  assert.deepEqual(stops[0], [0, 1]);
  assert.deepEqual(stops.at(-1), [1, 0]);
  for (let i = 1; i < stops.length; i++) {
    assert.ok(stops[i]![0] >= stops[i - 1]![0], "positions ascend");
    assert.ok(stops[i]![1] <= stops[i - 1]![1], "alpha never rises");
  }
});

test("avatar decorations load as a static PNG", () => {
  const url = staticDecorationUrl("https://cdn.discordapp.com/avatar-decoration-presets/a_abc.png");
  assert.equal(url, "https://cdn.discordapp.com/avatar-decoration-presets/a_abc.png?size=240&passthrough=false");
  assert.equal(staticDecorationUrl(null), null);
  assert.equal(staticDecorationUrl("not a url"), null);
});

test("snapshot age reads in whole hours", () => {
  const asOf = "2026-11-24T00:00:00.000Z";
  assert.equal(snapshotAgeLabel(asOf, new Date("2026-11-24T00:40:00Z")), "as of less than 1h ago");
  assert.equal(snapshotAgeLabel(asOf, new Date("2026-11-24T01:00:00Z")), "as of 1h ago");
  assert.equal(snapshotAgeLabel(new Date(asOf), new Date("2026-11-24T15:59:00Z")), "as of 15h ago");
  assert.equal(snapshotAgeLabel("bad", new Date()), "as of less than 1h ago");
});

test("voice time reads compactly", () => {
  assert.equal(formatVoiceMinutes(45), "45m");
  assert.equal(formatVoiceMinutes(200), "3h 20m");
  assert.equal(formatVoiceMinutes(180), "3h");
  assert.equal(formatVoiceMinutes(128 * 60 + 5), "128h");
});

test("member-since dates read like Discord's", () => {
  assert.equal(formatProfileDate(new Date(Date.UTC(2017, 0, 21, 23, 30))), "21 Jan 2017");
  assert.equal(formatProfileDate("2026-03-05T10:00:00Z"), "5 Mar 2026");
  assert.equal(formatProfileDate(null), null);
  assert.equal(formatProfileDate("not a date"), null);
});

test("chips wrap into rows and keep room for a +N chip", () => {
  const more = () => 20;
  // Everything fits: no overflow chip.
  assert.deepEqual(layoutChips([40, 40, 40], 100, 5, 2, more), { rows: [[0, 1], [2]], hidden: 0 });
  // One row allowed: chips make way for "+N" (30+5+30+5+20 = 90 fits, a third chip doesn't).
  assert.deepEqual(layoutChips([30, 30, 30, 30], 100, 5, 1, more), { rows: [[0, 1]], hidden: 2 });
  // The +N chip needs more room than the row has left: the last chip steps aside.
  assert.deepEqual(layoutChips([45, 45, 45], 100, 5, 1, more), { rows: [[0]], hidden: 2 });
  assert.deepEqual(layoutChips([], 100, 5, 3, more), { rows: [], hidden: 0 });
});

test("last seen reads like the site's pill", () => {
  const now = new Date(Date.UTC(2026, 8, 30, 12));
  const ago = (ms: number) => new Date(now.getTime() - ms);
  assert.equal(lastSeenLabel(null, now), null);
  assert.deepEqual(lastSeenLabel(ago(60_000), now), { text: "Active now", active: true });
  assert.equal(lastSeenLabel(ago(6 * 60_000), now)?.text, "Last seen 6m ago");
  assert.equal(lastSeenLabel(ago(3 * 3_600_000), now)?.text, "Last seen 3h ago");
  assert.equal(lastSeenLabel(ago(40 * 86_400_000), now)?.text, "Last seen 1mo ago");
});

test("the avatar accent is its most colorful region, not the background", async () => {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#d9d9d9"; // mostly light gray
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#e0245e"; // a smaller, saturated region
  ctx.fillRect(16, 16, 24, 24);
  const color = dominantColor(await loadImage(canvas.toBuffer("image/png")));
  assert.equal(color, "#e0245e");
});

test("renders a card with no avatar, banner or badges", async () => {
  const buffer = await renderProfileCard(
    {
      displayName: "Pilot",
      username: "pilot",
      avatarURL: null,
      bannerURL: null,
      accent: "rgb(86, 98, 245)",
      progressionIcons: [],
      badges: [],
      lastActiveAt: null,
    },
    { scale: 1 },
  );
  const image = await loadImage(buffer);
  assert.equal(image.width, 760);
  assert.ok(image.height > 250);
});

test("renders the full layout with stats, a Ghost Mode view and overflowing badges", async () => {
  const base = {
    displayName: "A very long display name that has to be truncated somewhere",
    username: "pilot",
    avatarURL: null,
    bannerURL: null,
    accent: "#5662f5",
    progressionIcons: [],
    badges: Array.from({ length: 20 }, (_, i) => ({ name: `Badge ${i}`, icon: "", iconImageUrl: null, colorHex: "#22c55e" })),
    lastActiveAt: new Date(Date.UTC(2026, 8, 30, 11, 59)),
    now: new Date(Date.UTC(2026, 8, 30, 12)),
    accountCreatedAt: new Date(Date.UTC(2017, 0, 21)),
    oneSince: "2026-03-05T10:00:00Z",
  };
  const full = await loadImage(
    await renderProfileCard(
      {
        ...base,
        firstSeenAt: "2024-03-05",
        stats: {
          totalMessages: 123_456_789,
          serverCount: 12,
          globalRank: 3,
          streak: 9,
          daily: Array.from({ length: 60 }, (_, i) => i),
          voiceDaily: Array.from({ length: 30 }, () => 30),
          hours: Array.from({ length: 24 }, (_, h) => h),
        },
      },
      { scale: 1 },
    ),
  );
  assert.equal(full.width, 760);
  const ghost = await loadImage(
    await renderProfileCard({ ...base, lastActiveAt: null, stats: { hidden: true, totalMessages: 0, serverCount: 0, globalRank: null } }, { scale: 1 }),
  );
  assert.equal(ghost.width, 760);
});
