import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { dominantColor, lastSeenLabel, renderProfileCard } from "./profileCard.js";

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
