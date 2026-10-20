import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { GLOBAL_ASSET_KEY, pageAssetPath } from "../pageAssets.js";
import {
  cosmeticGlyphSupport,
  cosmeticNameFont,
  drawAvatarFrame,
  drawCosmeticName,
  drawGlow,
  drawRowFlair,
  drawShareBarFill,
  drawShareRingProgress,
  drawBackgroundStill,
  perimeterPoint,
} from "./canvas.js";
import { NAME_FONTS, ensureNameFont, nameFontStack } from "./fonts.js";
import { BAR_STYLES, FLAIR_STYLES, FRAME_PRESETS, NAME_COLOR_STYLES, type CosmeticStyle } from "./types.js";
import { cleanCanvasName } from "../canvasText.js";
import { renderLeaderboardImage, renderRankCard } from "../../plugins/stats/functions/charts.js";
import { renderProfileCard } from "../../plugins/stats/functions/profileCard.js";

function canvas() {
  const c = createCanvas(460 * 2, 120 * 2);
  const ctx = c.getContext("2d");
  ctx.scale(2, 2);
  return { c, ctx };
}

/** True when anything was drawn. */
function drewSomething(c: ReturnType<typeof createCanvas>): boolean {
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

test("every name font is bundled and registers", () => {
  for (const font of NAME_FONTS) assert.ok(ensureNameFont(font.id), `${font.id} (${font.file}) didn't register`);
  assert.equal(nameFontStack("nope", 20, "20px Inter").font, "20px Inter");
  assert.match(nameFontStack("pixel", 20, '700 20px "Inter Bold", sans-serif').font, /^20px "DL Name pixel", "Inter Bold", sans-serif$/);
});

test("names draw in every font and colour style", () => {
  for (const font of NAME_FONTS) {
    for (const style of NAME_COLOR_STYLES) {
      const { c, ctx } = canvas();
      const stack = cosmeticNameFont({ fontId: font.id }, 19, '19px "Inter Bold", Arial, sans-serif');
      const width = drawCosmeticName(ctx, "Coalbit", 10, 40, {
        font: stack,
        color: { style, colors: ["#ff0000", "#00ff00", "#0000ff"] },
        defaultColor: "#ffffff",
        sizePx: 19,
        shadow: true,
      });
      assert.ok(width > 10, `${font.id}/${style}`);
      assert.ok(drewSomething(c), `${font.id}/${style}`);
    }
  }
});

test("characters a name font lacks fall back instead of being dropped or boxed", () => {
  const base = '19px "Inter Bold", "Segoe UI", Arial, sans-serif';
  for (const font of NAME_FONTS) {
    const stack = cosmeticNameFont({ fontId: font.id }, 19, base);
    // Pixel/script faces lack most accented capitals; the fallback families cover them.
    const support = cosmeticGlyphSupport({ fontId: font.id }, 19, base);
    assert.ok(stack.includes(`"DL Name ${font.id}"`));
    const cleaned = cleanCanvasName(["Žofie Ångström"], support);
    assert.equal(cleaned, "Žofie Ångström", font.id);
    // A codepoint no font has is still stripped (never a .notdef box).
    assert.equal(cleanCanvasName(["Pilot͸"], support), "Pilot", font.id);
  }
});

// A background still, written straight into the store asset folder (not through savePageAsset, so
// nothing is pruned) and removed afterwards.
const STILL_ID = "testbgstill0001";
const STILL_URL = `/api/store/assets/${STILL_ID}`;
{
  const still = createCanvas(184, 42);
  const sctx = still.getContext("2d");
  const sky = sctx.createLinearGradient(0, 0, 184, 0);
  sky.addColorStop(0, "#ff00aa");
  sky.addColorStop(1, "#00ffcc");
  sctx.fillStyle = sky;
  sctx.fillRect(0, 0, 184, 42);
  const path = pageAssetPath(GLOBAL_ASSET_KEY, "store", STILL_ID);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, still.toBuffer("image/png"));
}
after(() => {
  try {
    unlinkSync(pageAssetPath(GLOBAL_ASSET_KEY, "store", STILL_ID));
  } catch {
    /* already gone */
  }
});

test("a background still draws cover-fit, and a missing one reports false", async () => {
  const { c, ctx } = canvas();
  assert.equal(await drawBackgroundStill(ctx, "/api/store/assets/doesnotexist", { x: 0, y: 0, w: 460, h: 120 }), false);
  assert.equal(await drawBackgroundStill(ctx, null, { x: 0, y: 0, w: 460, h: 120 }), false);
  assert.equal(drewSomething(c), false);
  assert.equal(await drawBackgroundStill(ctx, STILL_URL, { x: 0, y: 0, w: 460, h: 120 }), true);
  // Cover-fit: every corner is painted.
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (const [x, y] of [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]]) {
    assert.equal(data[(y! * c.width + x!) * 4 + 3], 255, `${x},${y}`);
  }
});

test("every frame, bar and flair preset draws", async () => {
  for (const preset of FRAME_PRESETS) {
    for (const radius of [16, 32]) {
      const { c, ctx } = canvas();
      await drawAvatarFrame(ctx, { preset, colors: ["#ff0000", "#ffcc00"], imageUrl: null }, { x: 30, y: 28, size: 64, radius });
      assert.ok(drewSomething(c), `${preset} r${radius}`);
    }
  }
  for (const style of BAR_STYLES) {
    const { c, ctx } = canvas();
    drawShareRingProgress(ctx, { style, colors: ["#ff0000", "#0000ff"] }, { cx: 60, cy: 60, r: 14, stroke: 3, pct: 64, accent: "#6d78ff" });
    drawShareBarFill(ctx, { style, colors: ["#ff0000"] }, { x: 100, y: 50, w: 300, h: 7, fillW: 180, radius: 4, accent: "#6d78ff" });
    assert.ok(drewSomething(c), style);
  }
  for (const style of FLAIR_STYLES) {
    const { c, ctx } = canvas();
    drawRowFlair(ctx, { style, color: "#facc15" }, { x: 10, y: 10, w: 400, h: 80 }, 12);
    assert.ok(drewSomething(c), style);
  }
  const { c, ctx } = canvas();
  drawGlow(ctx, { colors: ["#ff0000"], intensity: 1 }, { x: 0, y: 0, w: 460, h: 120 }, { x: 50, y: 60 });
  assert.ok(drewSomething(c));
});

test("perimeter points stay on a rounded square's outline", () => {
  for (let i = 0; i < 40; i++) {
    const p = perimeterPoint(0, 0, 64, 64, 16, i / 40);
    assert.ok(p.x >= -0.01 && p.x <= 64.01 && p.y >= -0.01 && p.y <= 64.01);
    assert.ok(p.x < 0.01 || p.x > 63.99 || p.y < 0.01 || p.y > 63.99 || Math.hypot(p.x - (p.x < 32 ? 16 : 48), p.y - (p.y < 32 ? 16 : 48)) - 16 < 0.01);
  }
});

const NO_FRAMES = { rankFramesUrls: [], profileFramesUrls: [], frameCount: null, fps: null };

const everything: CosmeticStyle = {
  glow: { colors: ["#4ade80", "#22d3ee"], intensity: 0.7 },
  nameFont: { fontId: "medieval" },
  nameColor: { style: "shimmer", colors: ["#34d399", "#22d3ee"] },
  frame: { preset: "flames", colors: ["#f97316", "#facc15"], imageUrl: null },
  background: { bgId: "aurora", colors: [], rankStillUrl: STILL_URL, profileStillUrl: STILL_URL, ...NO_FRAMES },
  title: { text: "Frequent Flyer", color: "#7dd3fc" },
  icon: { emoji: "✈️", imageUrl: null },
  bar: { style: "glow", colors: ["#22e5ff"] },
  flair: { style: "glow", color: "#facc15" },
};

test("the rank card grows a line only for an equipped title", async () => {
  const row = { rank: 1, name: "Coalbit ☃ 雲", count: 10, sharePct: 40, shareLabel: "40%" };
  const plain = await loadImage(await renderRankCard({ row, scale: 1 }));
  const styled = await loadImage(await renderRankCard({ row: { ...row, cosmetics: everything }, scale: 1 }));
  const noTitle = await loadImage(await renderRankCard({ row: { ...row, cosmetics: { ...everything, title: undefined } }, scale: 1 }));
  assert.equal(styled.width, 460);
  assert.equal(noTitle.height, plain.height);
  assert.ok(styled.height > plain.height);
});

/** The colour at a point of a PNG (card units, scale 1). */
async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const image = await loadImage(png);
  const c = createCanvas(image.width, image.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

test("cards draw a background's still, and fall back without one", async () => {
  const row = { rank: 4, name: "Pilot", count: 10, sharePct: 40, shareLabel: "40%" };
  const withStill = { background: { bgId: "aurora" as const, colors: [], rankStillUrl: STILL_URL, profileStillUrl: STILL_URL, ...NO_FRAMES } };
  const noStill = { background: { bgId: "aurora" as const, colors: [], rankStillUrl: null, profileStillUrl: null, ...NO_FRAMES } };
  const plain = await renderRankCard({ row, scale: 1 });
  const fallback = await renderRankCard({ row: { ...row, cosmetics: noStill }, scale: 1 });
  const stilled = await renderRankCard({ row: { ...row, cosmetics: withStill }, scale: 1 });
  // No still: exactly the normal card. With one: the still shows through the dim (pink at the left).
  assert.deepEqual(await pixelAt(fallback, 6, 50), await pixelAt(plain, 6, 50));
  const [r, g, b] = await pixelAt(stilled, 6, 50);
  assert.ok(r > g + 40 && r > 90, `rank still not visible: ${r},${g},${b}`);

  const profileData = {
    displayName: "Pilot",
    username: "pilot",
    avatarURL: null,
    bannerURL: null,
    accent: "#5662f5",
    progressionIcons: [],
    badges: [],
    lastActiveAt: null,
  };
  const profilePlain = await renderProfileCard(profileData, { scale: 1 });
  const profileFallback = await renderProfileCard({ ...profileData, cosmetics: noStill }, { scale: 1 });
  const profileStilled = await renderProfileCard({ ...profileData, cosmetics: withStill }, { scale: 1 });
  assert.deepEqual(await pixelAt(profileFallback, 20, 20), await pixelAt(profilePlain, 20, 20));
  const [pr, pg] = await pixelAt(profileStilled, 20, 20);
  assert.ok(pr > pg + 40, `profile still not visible: ${pr},${pg}`);
});

test("the profile card and image leaderboard draw with cosmetics", async () => {
  const profile = await loadImage(
    await renderProfileCard(
      {
        displayName: "Pilot",
        username: "pilot",
        avatarURL: null,
        bannerURL: null,
        accent: "#5662f5",
        progressionIcons: [],
        badges: [],
        lastActiveAt: null,
        cosmetics: everything,
      },
      { scale: 1 },
    ),
  );
  assert.equal(profile.width, 760);
  const board = await loadImage(
    await renderLeaderboardImage({
      title: "Top",
      scale: 1,
      rows: [
        { rank: 1, label: "Pilot", count: 5, shareLabel: "50%", sharePct: 50, cosmetics: everything },
        { rank: 2, label: "Crew", count: 5, shareLabel: "50%", sharePct: 50, cosmetics: { flair: { style: "shimmer", color: "#ffffff" } } },
      ],
    }),
  );
  assert.equal(board.width, 1100);
});
