import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { GLOBAL_ASSET_KEY, pageAssetPath } from "../../../core/pageAssets.js";
import { parseSlotStyle } from "../../../core/cosmetics/schema.js";
import type { BackgroundStyle } from "../../../core/cosmetics/types.js";
import { stopOffloadWorkers } from "../../../core/offload.js";
import { renderRankCardLayers, type RankCardRow } from "./charts.js";
import {
  cachedAnimatedCard,
  clearAnimatedCardCache,
  composeFrames,
  encodeAnimation,
  frameDelays,
  hasBackgroundFrames,
  LEADERBOARD_GIF_ATTEMPTS,
  loadBackgroundFrames,
  MASK_BACKGROUND,
  MASK_EDGE,
  MASK_OVERLAY,
  PROFILE_GIF_ATTEMPTS,
  quantizeAnimation,
  RANK_GIF_ATTEMPTS,
  recordTranslations,
  renderAnimatedLeaderboardImpl,
  renderAnimatedProfileCardImpl,
  renderAnimatedRankCard,
  renderAnimatedRankCardImpl,
  replayTranslator,
} from "./animatedCards.js";
import { claimMessageView, replyWithCard, upgradeToGif } from "./animatedReply.js";

// --- Fixture: two sprite sheets of 4 frames each (8 frames), written straight into the store
// asset folder (not through savePageAsset, so nothing is pruned) and removed afterwards. ---------

const FRAME_W = 920;
const FRAME_H = 208;
const SHEET_IDS = ["testbgframes01", "testbgframes02"];
const PROFILE_SHEET_IDS = ["testbgpframes01", "testbgpframes02"];
/** Frames at the GIF's own /rank size (3x), drawn 1:1; the sets above are older, smaller ones. */
const NATIVE_SHEET_IDS = ["testbgnframes01", "testbgnframes02"];

function writeSheet(id: string, first: number, w: number, h: number): void {
  const sheet = createCanvas(w, h * 4);
  const ctx = sheet.getContext("2d");
  for (let k = 0; k < 4; k++) {
    const frame = first + k;
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, `hsl(${frame * 40}, 80%, 45%)`);
    g.addColorStop(1, `hsl(${frame * 40 + 120}, 80%, 30%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, k * h, w, h);
    // A moving blob, so neighbouring frames differ in more than colour.
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(60 + frame * 90, k * h + h / 2, h / 4, 0, Math.PI * 2);
    ctx.fill();
  }
  const path = pageAssetPath(GLOBAL_ASSET_KEY, "store", id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sheet.toBuffer("image/png"));
}
writeSheet(SHEET_IDS[0]!, 0, FRAME_W, FRAME_H);
writeSheet(SHEET_IDS[1]!, 4, FRAME_W, FRAME_H);
writeSheet(PROFILE_SHEET_IDS[0]!, 0, 1140, 456);
writeSheet(PROFILE_SHEET_IDS[1]!, 4, 1140, 456);
writeSheet(NATIVE_SHEET_IDS[0]!, 0, 1380, 312);
writeSheet(NATIVE_SHEET_IDS[1]!, 4, 1380, 312);

after(async () => {
  for (const id of [...SHEET_IDS, ...PROFILE_SHEET_IDS, ...NATIVE_SHEET_IDS]) {
    try {
      unlinkSync(pageAssetPath(GLOBAL_ASSET_KEY, "store", id));
    } catch {
      /* already gone */
    }
  }
  await stopOffloadWorkers();
});

const background: BackgroundStyle = {
  bgId: "aurora",
  colors: [],
  rankStillUrl: null,
  profileStillUrl: null,
  rankFramesUrls: SHEET_IDS.map((id) => `/api/store/assets/${id}`),
  profileFramesUrls: PROFILE_SHEET_IDS.map((id) => `/api/store/assets/${id}`),
  frameCount: 8,
  fps: 12,
};

const row: RankCardRow = {
  rank: 2,
  name: "Pilot",
  count: 1234,
  sharePct: 32,
  shareLabel: "32%",
  accentColor: "#6d78ff",
  badges: [{ name: "Crew", icon: "", colorHex: "#22d3ee" }],
  cosmetics: { background, title: { text: "Frequent Flyer", color: "#7dd3fc" } },
};

// --- A minimal GIF reader: block structure only ---------------------------------------------------

type GifInfo = { header: string; width: number; height: number; images: number; loops: boolean; delays: number[] };

function readGif(bytes: Uint8Array): GifInfo {
  const header = Buffer.from(bytes.subarray(0, 6)).toString("latin1");
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  let p = 13;
  const packed = bytes[10]!;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  const skipSubBlocks = () => {
    while (bytes[p]! !== 0) p += bytes[p]! + 1;
    p += 1;
  };
  let images = 0;
  let loops = false;
  const delays: number[] = [];
  for (;;) {
    const block = bytes[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[p++];
      if (label === 0xff) {
        const size = bytes[p]!;
        const id = Buffer.from(bytes.subarray(p + 1, p + 1 + size)).toString("latin1");
        if (id === "NETSCAPE2.0") loops = true;
      }
      if (label === 0xf9) delays.push(bytes[p + 2]! | (bytes[p + 3]! << 8));
      skipSubBlocks();
    } else if (block === 0x2c) {
      images++;
      const local = bytes[p + 8]!;
      p += 9;
      if (local & 0x80) p += 3 * (1 << ((local & 7) + 1));
      p += 1; // LZW minimum code size
      skipSubBlocks();
    } else {
      throw new Error(`unexpected GIF block 0x${block?.toString(16)} at ${p - 1}`);
    }
  }
  return { header, width, height, images, loops, delays };
}

// --- Tests -------------------------------------------------------------------------------------

test("frames load from the sprite sheets, in order, at the GIF size", async () => {
  assert.ok(hasBackgroundFrames(background, "rank"));
  assert.ok(!hasBackgroundFrames({ ...background, frameCount: 7 }, "rank"), "frames must split evenly over the sheets");
  assert.ok(!hasBackgroundFrames({ ...background, rankFramesUrls: [] }, "rank"));
  assert.ok(!hasBackgroundFrames({ ...background, fps: null }, "profile"));
  const frames = await loadBackgroundFrames(background, "rank");
  assert.equal(frames?.length, 8);
  assert.deepEqual(
    frames!.map((f) => [f.sy, f.sw, f.sh]),
    [0, 1, 2, 3, 0, 1, 2, 3].map((k) => [k * FRAME_H, FRAME_W, FRAME_H]),
  );
  assert.equal(await loadBackgroundFrames({ ...background, rankFramesUrls: ["/api/store/assets/missing000"], frameCount: 8 }, "rank"), null);
});

test("the GIF encoder writes a valid looping GIF with every frame", async () => {
  const gif = await encodeAnimation({
    width: 64,
    height: 32,
    frames: 6,
    fps: 12,
    drawFrame: (ctx, i) => {
      ctx.fillStyle = `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 64, 32);
    },
  });
  const info = readGif(gif);
  assert.equal(info.header, "GIF89a");
  assert.deepEqual([info.width, info.height], [64, 32]);
  assert.equal(info.images, 6);
  assert.ok(info.loops, "missing the NETSCAPE2.0 loop extension");
  // Whole centiseconds that add up to the exact loop (6 frames at 12 fps = 50cs).
  assert.deepEqual(info.delays, [8, 9, 8, 8, 9, 8]);
  assert.equal(frameDelays(36, 18).reduce((a, b) => a + b, 0), 2000);
});

test("an animated /rank card is a GIF of every frame at scale 3, upscaling older frames", async () => {
  const recorder = recordTranslations((_key, fallback, vars) => fallback.replace("{share}", String(vars?.share ?? "")).replace("{count}", String(vars?.count ?? "")));
  recorder.t("stats.shareOfServerTraffic", "{share} of server traffic", { share: "32%" });
  const result = await renderAnimatedRankCardImpl(row, recorder.entries());
  const info = readGif(result.gif);
  assert.equal(info.header, "GIF89a");
  assert.equal(info.images, 8);
  assert.equal(result.frames, 8);
  assert.equal(result.fps, 12);
  assert.ok(info.loops);
  assert.equal(info.width, 1380);
  assert.equal(result.scale, 3);
  assert.equal(result.dither, 1);
  assert.equal(result.nativeFrames, false, "920px frames are upscaled to the 1380px GIF");
  assert.ok(result.bytes < 9 * 1024 * 1024);
});

test("frames generated at the GIF's size are drawn 1:1", async () => {
  const native = { ...background, rankFramesUrls: NATIVE_SHEET_IDS.map((id) => `/api/store/assets/${id}`) };
  const result = await renderAnimatedRankCardImpl({ ...row, cosmetics: { ...row.cosmetics, background: native } }, []);
  assert.equal(result.width, 1380);
  assert.equal(result.nativeFrames, true);
  assert.equal(readGif(result.gif).images, 8);
});

test("the overlay (text, avatar, badges) is identical in every frame; the background moves", async () => {
  const frames = (await loadBackgroundFrames(background, "rank"))!;
  const layers = await renderRankCardLayers({ row, scale: 1 }, frames[0]!);
  const { width, height } = layers.overlay;
  const composed = composeFrames({
    width,
    height,
    frames: 4,
    fps: 12,
    drawFrame: (ctx, i) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      layers.paintBackdrop(ctx, frames[i * 2]!);
      ctx.drawImage(layers.overlay, 0, 0);
    },
  });
  const overlay = layers.overlay.getContext("2d").getImageData(0, 0, width, height).data;
  let opaque = 0;
  let backgroundChanged = 0;
  for (let p = 0; p < overlay.length; p += 4) {
    if (overlay[p + 3] === 255) {
      opaque++;
      for (const frame of composed.slice(1)) {
        for (let c = 0; c < 4; c++) assert.equal(frame[p + c], composed[0]![p + c], `overlay pixel ${p / 4} changed`);
      }
    } else if (overlay[p + 3] === 0 && composed[0]![p + 3] === 255 && composed[1]![p] !== composed[0]![p]) {
      backgroundChanged++;
    }
  }
  assert.ok(opaque > 1500, `too little overlay drawn (${opaque} px)`);
  assert.ok(backgroundChanged > width * height * 0.3, "the background should animate");

  // And through the encoder: with one shared palette, the overlay maps to the same colours.
  const gif = await encodeAnimation({
    width,
    height,
    frames: 2,
    fps: 12,
    drawFrame: (ctx, i) => {
      layers.paintBackdrop(ctx, frames[i * 4]!);
      ctx.drawImage(layers.overlay, 0, 0);
    },
  });
  assert.equal(readGif(gif).images, 2);
});

test("the size guard steps down: dithering, then the frame rate, then the scale", async () => {
  // The order itself: every dither level at full rate first, then fewer frames, then smaller cards.
  for (const attempts of [RANK_GIF_ATTEMPTS, PROFILE_GIF_ATTEMPTS, LEADERBOARD_GIF_ATTEMPTS]) {
    const slowest = Math.max(...attempts.map((x) => x.step));
    for (let i = 1; i < attempts.length; i++) {
      const [prev, next] = [attempts[i - 1]!, attempts[i]!];
      assert.ok(next.scale <= prev.scale, "the scale never grows");
      if (next.scale === prev.scale) assert.ok(next.step > prev.step || (next.step === prev.step && next.dither < prev.dither), `bad order at ${i}`);
      if (next.step > prev.step) assert.equal(prev.dither, 0, "dithering goes before the frame rate");
      if (next.scale < prev.scale) assert.equal(prev.step, slowest, "the frame rate goes before the scale");
    }
  }
  assert.deepEqual(RANK_GIF_ATTEMPTS.slice(0, 4), [
    { scale: 3, step: 1, dither: 1 },
    { scale: 3, step: 1, dither: 0.5 },
    { scale: 3, step: 1, dither: 0 },
    { scale: 3, step: 2, dither: 0 },
  ]);

  // And in practice: each attempt's own size, then budgets only the later ones fit.
  const sizes: number[] = [];
  for (const attempt of RANK_GIF_ATTEMPTS.slice(0, 4)) sizes.push((await renderAnimatedRankCardImpl(row, [], { attempts: [attempt] })).bytes);
  assert.ok(sizes[0]! > sizes[2]!, `dithering should cost bytes (${sizes.join(", ")})`);
  const guarded = await renderAnimatedRankCardImpl(row, [], { maxBytes: sizes[0]! - 1 });
  assert.ok(guarded.bytes <= sizes[0]! - 1);
  assert.equal(guarded.scale, 3);
  assert.ok(guarded.dither < 1, "the first step down is less dithering");
  assert.equal(guarded.frames, 8, "at the full frame rate");
  const halfRate = await renderAnimatedRankCardImpl(row, [], { maxBytes: Math.min(...sizes.slice(0, 3)) - 1 });
  assert.deepEqual([halfRate.scale, halfRate.fps, halfRate.frames, halfRate.dither], [3, 6, 4, 0]);
  assert.equal(readGif(halfRate.gif).images, 4);
  const smaller = await renderAnimatedRankCardImpl(row, [], { maxBytes: Math.min(...sizes) - 1 });
  assert.ok(smaller.scale < 3, `expected a smaller scale, got ${smaller.scale}`);
  await assert.rejects(renderAnimatedRankCardImpl(row, [], { maxBytes: 100 }), /too large/);
});

/** A real /rank overlay over the fixture frames, at the GIF's scale. */
async function rankAnimation(dither: number) {
  const frames = (await loadBackgroundFrames(background, "rank"))!;
  const layers = await renderRankCardLayers({ row, scale: 3 }, frames[0]!);
  const { width, height } = layers.overlay;
  const overlay = layers.overlay.getContext("2d").getImageData(0, 0, width, height).data;
  const quantized = await quantizeAnimation({
    width,
    height,
    frames: 4,
    fps: 12,
    overlay,
    dither,
    drawFrame: (ctx, i) => {
      ctx.setTransform(3, 0, 0, 3, 0, 0);
      layers.paintBackdrop(ctx, frames[i * 2]!);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layers.overlay, 0, 0);
    },
  });
  return { overlay, quantized };
}

const rgbKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

test("the palette holds the overlay's colours exactly, and overlay pixels never change", async () => {
  const { overlay, quantized } = await rankAnimation(1);
  const { palette, frames, mask, reserved } = quantized;
  assert.ok(reserved >= 8, `only ${reserved} reserved colours`);
  // The overlay's most common colours (card text, chips, ring) are exact palette entries, and every
  // pixel of those colours lands on them.
  const counts = new Map<number, number>();
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== MASK_OVERLAY) continue;
    const key = rgbKey(overlay[p * 4]!, overlay[p * 4 + 1]!, overlay[p * 4 + 2]!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const common = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key]) => key);
  const exact = new Set(palette.slice(0, 255).map(([r, g, b]) => rgbKey(r!, g!, b!)));
  for (const key of common) assert.ok(exact.has(key), `#${key.toString(16).padStart(6, "0")} isn't in the palette`);
  let checked = 0;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== MASK_OVERLAY) continue;
    const key = rgbKey(overlay[p * 4]!, overlay[p * 4 + 1]!, overlay[p * 4 + 2]!);
    if (!common.includes(key)) continue;
    const [r, g, b] = palette[frames[0]![p]!]!;
    assert.equal(rgbKey(r!, g!, b!), key, `overlay pixel ${p} lost its colour`);
    checked++;
  }
  assert.ok(checked > 1000, `only ${checked} overlay pixels checked`);
  // The same index (so the same colour) in every frame.
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== MASK_OVERLAY) continue;
    for (const frame of frames.slice(1)) assert.equal(frame[p], frames[0]![p], `overlay pixel ${p} changed`);
  }
});

test("only the background is dithered", async () => {
  const dithered = (await rankAnimation(1)).quantized;
  const plain = (await rankAnimation(0)).quantized;
  assert.deepEqual(dithered.palette, plain.palette, "dithering doesn't change the palette");
  let background = 0;
  let changed = 0;
  for (let p = 0; p < dithered.mask.length; p++) {
    const m = dithered.mask[p];
    for (let f = 0; f < dithered.frames.length; f++) {
      const same = dithered.frames[f]![p] === plain.frames[f]![p];
      if (m === MASK_OVERLAY || m === MASK_EDGE) assert.ok(same, `covered pixel ${p} was dithered`);
      else if (m === MASK_BACKGROUND && f === 0 && dithered.frames[f]![p] !== 255) {
        background++;
        if (!same) changed++;
      }
    }
  }
  assert.ok(changed > background * 0.1, `the background should be dithered (${changed}/${background})`);
});

test("animated /profile and leaderboard GIFs", async () => {
  const profile = await renderAnimatedProfileCardImpl({
    displayName: "Pilot",
    username: "pilot",
    avatarURL: null,
    bannerURL: null,
    accent: "#5662f5",
    progressionIcons: [],
    badges: [],
    lastActiveAt: null,
    now: new Date(),
    cosmetics: { background },
  });
  assert.equal(readGif(profile.gif).images, 8);
  assert.equal(profile.width, 1520);
  assert.equal(profile.scale, 2);

  const plainRow = { rank: 1, label: "Captain", count: 50, shareLabel: "50%", sharePct: 50 };
  const leaderboard = await renderAnimatedLeaderboardImpl(
    {
      title: "Top messagers",
      rows: [plainRow, { ...plainRow, rank: 2, label: "Pilot", cosmetics: { background } }],
    },
    [],
  );
  const info = readGif(leaderboard.gif);
  assert.equal(info.images, 4); // every other frame
  assert.equal(info.width, 1100);
  await assert.rejects(renderAnimatedLeaderboardImpl({ title: "x", rows: [plainRow] }, []), /no listed row/);
});

test("the worker renders the GIF off the main thread", async () => {
  const result = await renderAnimatedRankCard(row, []);
  assert.equal(readGif(result.gif).images, 8);
});

test("translations recorded on the main thread replay in the worker", () => {
  const recorder = recordTranslations((key, fallback) => (key === "a" ? "Bonjour" : fallback));
  recorder.t("a", "Hello");
  recorder.t("b", "{n} msgs", { n: 3 });
  const replay = replayTranslator(recorder.entries());
  assert.equal(replay("a", "Hello"), "Bonjour");
  assert.equal(replay("b", "{n} msgs", { n: 3 }), "{n} msgs");
  assert.equal(replay("c", "{n} more", { n: 2 }), "2 more");
});

test("the background schema accepts animation frames", () => {
  const parsed = parseSlotStyle("background", {
    bgId: "aurora",
    rankFramesUrls: ["/api/store/assets/abc", "def"],
    profileFramesAssetIds: ["ghi"],
    frameCount: 24,
    fps: 12,
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.style, {
    bgId: "aurora",
    colors: [],
    rankStillAssetId: null,
    profileStillAssetId: null,
    rankFramesAssetIds: ["abc", "def"],
    profileFramesAssetIds: ["ghi"],
    frameCount: 24,
    fps: 12,
  });
  // Frames without a count/rate are dropped, and only uploads are accepted.
  const partial = parseSlotStyle("background", { bgId: "aurora", rankFramesAssetIds: ["abc"] });
  assert.ok(partial.ok && (partial.style as { rankFramesAssetIds: string[] }).rankFramesAssetIds.length === 0);
  assert.equal(parseSlotStyle("background", { bgId: "aurora", rankFramesUrls: ["https://evil.example/x.png"], frameCount: 24, fps: 12 }).ok, false);
  assert.equal(parseSlotStyle("background", { bgId: "aurora", frameCount: 1000, fps: 12 }).ok, false);
});

test("the GIF cache reuses a render and keeps the still on errors", async () => {
  clearAnimatedCardCache();
  let renders = 0;
  const ok = async () => {
    renders++;
    return { gif: new Uint8Array([71, 73, 70]), width: 1, height: 1, frames: 1, fps: 1, scale: 1, dither: 0, nativeFrames: false, bytes: 3, ms: 1 };
  };
  const [a, b] = await Promise.all([cachedAnimatedCard("rank:u:k", ok), cachedAnimatedCard("rank:u:k", ok)]);
  assert.deepEqual([...a!], [71, 73, 70]);
  assert.equal(b, a);
  assert.equal(await cachedAnimatedCard("rank:u:k", ok), a);
  assert.equal(renders, 1);
  assert.equal(await cachedAnimatedCard("rank:u:bad", async () => Promise.reject(new Error("encode failed"))), null);
});

type Call = { files?: Array<{ name: string | null }>; attachments?: unknown[]; components?: unknown; content?: string };

test("/rank sends the still, then edits the same reply with the GIF", async () => {
  const calls: Call[] = [];
  const edit = async (options: Call) => {
    calls.push(options);
  };
  const components = [{ type: 1 }];
  const outcome = await replyWithCard(edit, { buffer: Buffer.from("png"), animate: async () => Buffer.from("gif") }, "rank", {
    content: "",
    components,
  });
  assert.equal(outcome, "gif");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.files![0]!.name, "rank.png");
  assert.equal(calls[1]!.files![0]!.name, "rank.gif");
  assert.deepEqual(calls[1]!.attachments, []);
  assert.equal(calls[1]!.components, components);
});

test("the still stays when the GIF fails, times out or can't be uploaded", async () => {
  const calls: Call[] = [];
  const edit = async (options: Call) => {
    calls.push(options);
  };
  assert.equal(await replyWithCard(edit, { buffer: Buffer.from("png"), animate: async () => null }, "rank", {}), "still");
  assert.equal(await replyWithCard(edit, { buffer: Buffer.from("png"), animate: () => Promise.reject(new Error("boom")) }, "rank", {}), "still");
  assert.equal(await replyWithCard(edit, { buffer: Buffer.from("png") }, "profile", {}), "still");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.files![0]!.name!.endsWith(".png")));

  let attempts = 0;
  const failingGifEdit = async (options: Call) => {
    attempts++;
    if (options.files?.[0]?.name?.endsWith(".gif")) throw new Error("413 Payload Too Large");
  };
  assert.equal(await replyWithCard(failingGifEdit, { buffer: Buffer.from("png"), animate: async () => Buffer.from("gif") }, "rank", {}), "still");
  assert.equal(attempts, 2);
  // The still upload failing is the caller's to handle.
  await assert.rejects(replyWithCard(async () => Promise.reject(new Error("down")), { buffer: Buffer.from("png") }, "rank", {}));
});

test("a newer view of a message drops an older view's GIF", async () => {
  const calls: Call[] = [];
  const edit = async (options: Call) => {
    calls.push(options);
  };
  const first = claimMessageView("msg-1");
  const second = claimMessageView("msg-1");
  assert.equal(await upgradeToGif(edit, async () => Buffer.from("gif"), "chart", {}, first), false);
  assert.equal(await upgradeToGif(edit, async () => Buffer.from("gif"), "chart", {}, second), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.files![0]!.name, "chart.gif");
});
