import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MILESTONE_UNSEEDED,
  buildStreamSummary,
  classifyUpload,
  formatStreamDuration,
  hourInZone,
  isQuietHour,
  parseIsoDuration,
  resolveTypeMessage,
  seedSubscriberMilestone,
  streamHasEnded,
  STREAM_END_GRACE_MS,
  subscriberMilestoneToAnnounce,
  uploadKindEnabled,
  uploadKindLabel,
  withinCooldown,
} from "./logic.js";
import { extractVideoId } from "./youtube.js";
import { parseSocialWatcherOptions } from "../../../config/schemas/social.js";

test("parseIsoDuration handles YouTube durations", () => {
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("PT1M"), 60);
  assert.equal(parseIsoDuration("PT2M59S"), 179);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("P1DT1H"), 90_000);
  assert.equal(parseIsoDuration("P0D"), 0);
  assert.equal(parseIsoDuration(""), null);
  assert.equal(parseIsoDuration("PT"), null);
  assert.equal(parseIsoDuration("nonsense"), null);
  assert.equal(parseIsoDuration(undefined), null);
});

test("classifyUpload: livestreams and premieres", () => {
  assert.equal(classifyUpload({ liveBroadcastContent: "live", durationSeconds: 0 }), "live");
  assert.equal(classifyUpload({ liveBroadcastContent: "upcoming", durationSeconds: null }), "live");
  // A finished stream's VOD still carries liveStreamingDetails.
  assert.equal(classifyUpload({ liveBroadcastContent: "none", hasLiveStreamingDetails: true, durationSeconds: 40 }), "live");
});

test("classifyUpload: Shorts", () => {
  assert.equal(classifyUpload({ durationSeconds: 30, shortsProbe: true }), "short");
  assert.equal(classifyUpload({ durationSeconds: 170, shortsProbe: true }), "short");
  // The Shorts URL redirected to /watch: a regular short video.
  assert.equal(classifyUpload({ durationSeconds: 30, shortsProbe: false }), "video");
  // Longer than three minutes can never be a Short, whatever the probe says.
  assert.equal(classifyUpload({ durationSeconds: 181, shortsProbe: true }), "video");
  // Probe unavailable: fall back to the 60 second rule.
  assert.equal(classifyUpload({ durationSeconds: 60, shortsProbe: null }), "short");
  assert.equal(classifyUpload({ durationSeconds: 61, shortsProbe: null }), "video");
});

test("classifyUpload: regular videos", () => {
  assert.equal(classifyUpload({ durationSeconds: 600 }), "video");
  assert.equal(classifyUpload({ durationSeconds: null }), "video");
  assert.equal(classifyUpload({}), "video");
});

test("upload type toggles, labels and per-type messages", () => {
  const options = parseSocialWatcherOptions({ notify_shorts: false });
  assert.equal(uploadKindEnabled(options, "video"), true);
  assert.equal(uploadKindEnabled(options, "short"), false);
  assert.equal(uploadKindEnabled(options, "live"), true);
  assert.equal(uploadKindLabel("short"), "Short");
  assert.equal(uploadKindLabel("live", "upcoming"), "upcoming stream");
  assert.equal(uploadKindLabel("live", "live"), "livestream");

  const main = { messageContent: "main", mentionRoleIds: ["111111"] };
  assert.deepEqual(resolveTypeMessage(options, "short", main), main);
  const custom = parseSocialWatcherOptions({ live_override: { custom: true, message: "We're live!", role_ids: ["222222"] } });
  assert.deepEqual(resolveTypeMessage(custom, "live", main), { messageContent: "We're live!", mentionRoleIds: ["222222"] });
  // Custom with an empty message keeps the main text but uses the type's roles.
  const rolesOnly = parseSocialWatcherOptions({ short_override: { custom: true, message: " ", role_ids: [] } });
  assert.deepEqual(resolveTypeMessage(rolesOnly, "short", main), { messageContent: "main", mentionRoleIds: [] });
});

test("old rows ('{}') parse to the original behaviour, bad fields fall back alone", () => {
  const options = parseSocialWatcherOptions({});
  assert.equal(options.notify_videos && options.notify_shorts && options.notify_live, true);
  assert.equal(options.end_action, "none");
  assert.equal(options.milestones, false);
  assert.equal(options.milestone_last, MILESTONE_UNSEEDED);
  const partial = parseSocialWatcherOptions({ cooldown_minutes: 99999, end_action: "edit" });
  assert.equal(partial.cooldown_minutes, 0);
  assert.equal(partial.end_action, "edit");
});

test("quiet hours wrap past midnight", () => {
  assert.equal(isQuietHour(23, 23, 8), true);
  assert.equal(isQuietHour(3, 23, 8), true);
  assert.equal(isQuietHour(8, 23, 8), false);
  assert.equal(isQuietHour(12, 23, 8), false);
  assert.equal(isQuietHour(13, 9, 17), true);
  assert.equal(isQuietHour(17, 9, 17), false);
  assert.equal(isQuietHour(5, 5, 5), false);
  const noonUtc = new Date("2026-06-01T12:00:00Z");
  assert.equal(hourInZone(noonUtc, "UTC"), 12);
  assert.equal(hourInZone(noonUtc, "Asia/Tokyo"), 21);
  assert.equal(hourInZone(noonUtc, "Not/AZone"), 12);
});

test("cooldown window", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.equal(withinCooldown(new Date("2026-06-01T11:50:00Z"), 15, now), true);
  assert.equal(withinCooldown(new Date("2026-06-01T11:45:00Z"), 15, now), false);
  assert.equal(withinCooldown(new Date("2026-06-01T11:59:00Z"), 0, now), false);
  assert.equal(withinCooldown(null, 30, now), false);
});

test("stream end grace and duration formatting", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.equal(streamHasEnded(new Date(now.getTime() - STREAM_END_GRACE_MS + 1000), now), false);
  assert.equal(streamHasEnded(new Date(now.getTime() - STREAM_END_GRACE_MS), now), true);
  assert.equal(formatStreamDuration(30_000), "under a minute");
  assert.equal(formatStreamDuration(45 * 60_000), "45m");
  assert.equal(formatStreamDuration(2 * 3_600_000), "2h");
  assert.equal(formatStreamDuration(3 * 3_600_000 + 12 * 60_000 + 59_000), "3h 12m");
  assert.equal(formatStreamDuration(-5), "under a minute");
});

test("stream summary", () => {
  const base = {
    streamerName: "Alice",
    title: "  Speedruns all day ",
    gameName: "Celeste",
    startedAt: new Date("2026-06-01T10:00:00Z"),
    endedAt: new Date("2026-06-01T12:30:00Z"),
    peakViewers: 1234,
    vodUrl: "https://www.twitch.tv/videos/1",
    channelUrl: "https://www.twitch.tv/alice",
  };
  const summary = buildStreamSummary(base);
  assert.equal(summary.heading, "Alice was live");
  assert.equal(summary.title, "Speedruns all day");
  assert.deepEqual(summary.fields, [
    { name: "Streamed for", value: "2h 30m", inline: true },
    { name: "Category", value: "Celeste", inline: true },
    { name: "Peak viewers", value: "1,234", inline: true },
  ]);
  assert.deepEqual(summary.button, { label: "Watch the VOD", url: "https://www.twitch.tv/videos/1" });

  const bare = buildStreamSummary({ ...base, title: "", gameName: null, peakViewers: 0, vodUrl: null });
  assert.equal(bare.title, "Stream");
  assert.equal(bare.fields.length, 1);
  assert.deepEqual(bare.button, { label: "Open channel", url: "https://www.twitch.tv/alice" });
  for (const text of [summary.heading, summary.title, ...summary.fields.flatMap((f) => [f.name, f.value]), summary.button.label]) {
    assert.equal(text.includes("—"), false);
  }
});

test("subscriber milestones", () => {
  // Seeding records where the channel is, so nothing old fires.
  assert.equal(seedSubscriberMilestone(12_345, false), 10_000);
  assert.equal(seedSubscriberMilestone(50, false), 0);
  assert.equal(seedSubscriberMilestone(5_000, true), MILESTONE_UNSEEDED);
  assert.equal(seedSubscriberMilestone(null, false), MILESTONE_UNSEEDED);
  // Only the highest crossed milestone, once.
  assert.equal(subscriberMilestoneToAnnounce(10_000, 26_000, false), 25_000);
  assert.equal(subscriberMilestoneToAnnounce(1_000, 60_000, false), 50_000);
  assert.equal(subscriberMilestoneToAnnounce(25_000, 24_900, false), null);
  assert.equal(subscriberMilestoneToAnnounce(25_000, 26_000, false), null);
  assert.equal(subscriberMilestoneToAnnounce(1_000_000, 2_010_000, false), 2_000_000);
  // Hidden counts and unseeded creators stay quiet.
  assert.equal(subscriberMilestoneToAnnounce(1_000, 5_000, true), null);
  assert.equal(subscriberMilestoneToAnnounce(MILESTONE_UNSEEDED, 5_000, false), null);
});

test("extractVideoId reads video links", () => {
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("youtube.com/watch?feature=share&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=3"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(extractVideoId("https://www.youtube.com/@mkbhd"), null);
  assert.equal(extractVideoId("@mkbhd"), null);
});
