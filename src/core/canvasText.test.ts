import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canvasGlyphSupport,
  canvasShowsNotdef,
  cleanCanvasName,
  firstGrapheme,
  sanitizeCanvasText,
  stripUnsupportedGlyphs,
  truncateToFit,
} from "./canvasText.js";

// A fake font: Latin, the emoji below, and the combining acute accent.
const SUPPORTED = new Set(
  [..."👍👩💻🏳🌈🇬🇧🏴❤"].map((c) => c.codePointAt(0)!).concat([0x301, 0xe9, 0x1f3fd]),
);
const fakeFont = (cp: number) => (cp >= 0x20 && cp <= 0x7e) || SUPPORTED.has(cp);

test("drops characters the font can't draw and collapses the gap they leave", () => {
  assert.equal(stripUnsupportedGlyphs("Coal ꧁ ꧂ Dev", fakeFont), "Coal Dev");
  assert.equal(stripUnsupportedGlyphs("𝓒𝓸𝓪𝓵 Ryan", fakeFont), "Ryan");
  assert.equal(stripUnsupportedGlyphs("  café  ", fakeFont), "café");
});

test("keeps supported emoji sequences whole", () => {
  assert.equal(stripUnsupportedGlyphs("dev 👩‍💻", fakeFont), "dev 👩‍💻");
  assert.equal(stripUnsupportedGlyphs("👍🏽 ok", fakeFont), "👍🏽 ok");
  assert.equal(stripUnsupportedGlyphs("🏳️‍🌈", fakeFont), "🏳️‍🌈");
  assert.equal(stripUnsupportedGlyphs("🇬🇧", fakeFont), "🇬🇧");
  assert.equal(stripUnsupportedGlyphs("❤️ love", fakeFont), "❤️ love");
  assert.equal(stripUnsupportedGlyphs("#️⃣1", fakeFont), "#️⃣1");
  // England flag: black flag + tag characters + cancel tag.
  assert.equal(stripUnsupportedGlyphs("🏴󠁧󠁢󠁥󠁮󠁧󠁿", fakeFont), "🏴󠁧󠁢󠁥󠁮󠁧󠁿");
});

test("an unsupported part of a ZWJ sequence goes without leaving a dangling joiner", () => {
  // 🦰 is not in the fake font.
  assert.equal(stripUnsupportedGlyphs("a👩‍🦰", fakeFont), "a👩");
});

test("combining marks stay on their letter when supported and go when not", () => {
  assert.equal(stripUnsupportedGlyphs("é", fakeFont), "é");
  assert.equal(stripUnsupportedGlyphs("e҉x", fakeFont), "ex");
  // Zalgo-style stacks of unsupported marks disappear entirely.
  assert.equal(stripUnsupportedGlyphs("h̷̵̶i", fakeFont), "hi");
});

test("invisible controls and bidi overrides are removed", () => {
  assert.equal(stripUnsupportedGlyphs("a‮b​c\u0007", fakeFont), "abc");
  assert.equal(stripUnsupportedGlyphs("tab\tnew\nline", fakeFont), "tab new line");
});

test("cleanCanvasName falls back when a name ends up empty", () => {
  assert.equal(cleanCanvasName(["꧁꧂", "coal"], fakeFont), "coal");
  assert.equal(cleanCanvasName(["​", null, "ꦿ"], fakeFont), "Unknown user");
  assert.equal(cleanCanvasName(["ꦿ"], fakeFont, "Member"), "Member");
  assert.equal(cleanCanvasName(["Coal 👍"], fakeFont), "Coal 👍");
});

test("truncateToFit never splits an emoji into a lone surrogate", () => {
  const fitsLength = (max: number) => (s: string) => s.length <= max;
  assert.equal(truncateToFit("short", fitsLength(10)), "short");
  assert.equal(truncateToFit("ab👩‍💻cd", fitsLength(4)), "ab…");
  const cut = truncateToFit("x😀😀😀😀", fitsLength(4));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), cut);
  assert.equal(firstGrapheme("👍🏽hi"), "👍🏽");
  assert.equal(firstGrapheme(""), undefined);
});

test("measured support keeps ordinary text and drops what draws as .notdef", () => {
  const font = '32px "Segoe UI", "DejaVu Sans", Arial, sans-serif';
  assert.equal(sanitizeCanvasText("Hello World", font), "Hello World");
  const support = canvasGlyphSupport(font);
  assert.equal(support(0x41), true);
  if (canvasShowsNotdef(font)) {
    // U+0378 is unassigned: no font maps it, so it is exactly the .notdef glyph.
    assert.equal(support(0x378), false);
    assert.equal(sanitizeCanvasText("A͸B", font), "AB");
  }
});
