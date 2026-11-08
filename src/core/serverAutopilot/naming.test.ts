import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NAMING,
  NAMING_PRESETS,
  applyFont,
  decorationLength,
  fillPattern,
  formatName,
  matchNamingPreset,
  nameWords,
  namingPreset,
  truncateName,
  validPattern,
  type SANameKind,
} from "./naming.js";
import type { SANaming } from "./types.js";

const n = (patch: Partial<SANaming> = {}): SANaming => ({ ...DEFAULT_NAMING, ...patch });

describe("nameWords", () => {
  it("splits on spaces, dashes and underscores and lowercases", () => {
    assert.deepEqual(nameWords("General  Chat"), ["general", "chat"]);
    assert.deepEqual(nameWords("off--topic_zone"), ["off", "topic", "zone"]);
  });
  it("strips characters Discord forbids", () => {
    assert.deepEqual(nameWords("#rules @here: `code`"), ["rules", "here", "code"]);
  });
  it("keeps unicode letters", () => {
    assert.deepEqual(nameWords("Allgemeiner Chat für Größen"), ["allgemeiner", "chat", "für", "größen"]);
    assert.deepEqual(nameWords("雑談 ルーム"), ["雑談", "ルーム"]);
  });
  it("returns nothing for empty input", () => {
    assert.deepEqual(nameWords("  -_ "), []);
  });
});

describe("fillPattern", () => {
  const cases: Array<[string, string | null, string]> = [
    ["{emoji}｜{name}", "💬", "💬｜X"],
    ["{emoji}｜{name}", null, "X"],
    ["{emoji}・{name}", null, "X"],
    ["{emoji} {name}", null, "X"],
    ["「{emoji}」{name}", null, "X"],
    ["╭・{emoji}︰{name}", null, "╭X"],
    ["꒰ {emoji} ꒱ {name}", null, "X"],
    ["【{emoji} {name}】", null, "X"],
    ["【{emoji} {name}】", "🌿", "【🌿 X】"],
    ["┃{emoji}┃{name}", null, "X"],
    ["{name} {emoji}", null, "X"],
    ["{name}・{emoji}", null, "X"],
    ["a {emoji} b {name}", null, "a b X"],
    ["── {name} ──", null, "── X ──"],
    ["✦ {name} ✦", "🌟", "✦ X ✦"],
    ["{emoji}", null, "X"],
    ["{emoji}{emoji}{name}", null, "X"],
    ["{emoji}", "🎮", "🎮"],
  ];
  for (const [pattern, emoji, expected] of cases) {
    it(`${pattern} with ${emoji ?? "no emoji"} → ${expected}`, () => {
      assert.equal(fillPattern(pattern, "X", emoji), expected);
    });
  }
});

describe("applyFont", () => {
  it("maps letters and digits only", () => {
    assert.equal(applyFont("abc-1", "small_caps"), "ᴀʙᴄ-1");
    assert.equal(applyFont("Ab 1", "bold"), "𝗔𝗯 𝟭");
    assert.equal(applyFont("Ab 1", "italic"), "𝘈𝘣 1");
    assert.equal(applyFont("Ab 1", "monospace"), "𝙰𝚋 𝟷");
    assert.equal(applyFont("Ab 1", "fullwidth"), "Ａｂ １");
    assert.equal(applyFont("Ab 1", "normal"), "Ab 1");
    assert.equal(applyFont("ünï 🎮", "bold"), "ü𝗻ï 🎮");
  });
});

describe("truncateName", () => {
  it("keeps names up to 100 code points", () => {
    assert.equal(truncateName("a".repeat(100)), "a".repeat(100));
    assert.equal(truncateName("a".repeat(130)).length, 100);
  });
  it("never splits an emoji grapheme", () => {
    const family = "👨‍👩‍👧"; // 5 code points
    const name = `${"x".repeat(98)}${family}`;
    assert.equal(truncateName(name), "x".repeat(98));
  });
});

describe("formatName", () => {
  const table: Array<[string, Partial<SANaming>, SANameKind, string, string, string]> = [
    ["default text", {}, "text", "General Chat", "💬", "general-chat"],
    ["default voice", {}, "voice", "chill lounge", "🎧", "Chill Lounge"],
    ["default category", {}, "category", "community hub", "🌿", "COMMUNITY HUB"],
    ["emoji bar text", { channel_pattern: "{emoji}｜{name}", emoji_mode: "all" }, "text", "general chat", "💬", "💬｜general-chat"],
    ["emoji only on categories", { channel_pattern: "{emoji}｜{name}", emoji_mode: "categories" }, "text", "general chat", "💬", "general-chat"],
    ["emoji only on channels skips categories", { category_pattern: "{emoji} {name}", emoji_mode: "channels" }, "category", "info", "📌", "INFO"],
    ["emoji none", { channel_pattern: "{emoji}・{name}", emoji_mode: "none" }, "text", "memes", "😂", "memes"],
    ["text spaces become dashes", { channel_pattern: "{emoji} {name}", emoji_mode: "all" }, "text", "welcome", "👋", "👋-welcome"],
    ["underscore separator", { separator: "_" }, "text", "off topic", "", "off_topic"],
    ["dot separator", { separator: "・" }, "text", "game night", "", "game・night"],
    ["joined words", { separator: "" }, "text", "game night", "", "gamenight"],
    ["text ignores ASCII case", { channel_pattern: "{name}-HQ" }, "text", "Art", "", "art-hq"],
    ["forbidden chars", {}, "text", "#off--topic @here: `x`", "", "off-topic-here-x"],
    ["bold font text", { font: "bold", separator: "・" }, "text", "Game Night 2", "", "𝗴𝗮𝗺𝗲・𝗻𝗶𝗴𝗵𝘁・𝟮"],
    ["small caps category", { font: "small_caps", category_case: "upper" }, "category", "staff", "", "ꜱᴛᴀꜰꜰ"],
    ["fullwidth title category", { font: "fullwidth", category_case: "title" }, "category", "staff area", "", "Ｓｔａｆｆ Ａｒｅａ"],
    ["lower category", { category_case: "lower", category_pattern: "⌜{name}⌟" }, "category", "Voice Rooms", "", "⌜voice rooms⌟"],
    ["monospace upper voice", { font: "monospace", voice_case: "upper" }, "voice", "duo 1", "", "𝙳𝚄𝙾 𝟷"],
    ["channel_case lower forces voice lowercase", { channel_case: "lower", voice_case: "upper" }, "voice", "Gaming", "", "gaming"],
    ["stage uses voice rules", { voice_pattern: "🎤・{name}" }, "stage", "town hall", "", "🎤・Town Hall"],
    ["forum is text-like", { channel_pattern: "{emoji}︰{name}", emoji_mode: "all" }, "forum", "Showcase Board", "🖼️", "🖼️︰showcase-board"],
    ["announcement is text-like", {}, "announcement", "News Feed", "", "news-feed"],
    ["empty base falls back", {}, "text", "", "", "channel"],
    ["empty category base falls back", {}, "category", "  ", "", "CATEGORY"],
    ["boxed category without emoji", { category_pattern: "【{emoji} {name}】", emoji_mode: "channels" }, "category", "info", "📌", "INFO"],
    ["aesthetic category", { category_pattern: "꒰ {emoji} ꒱ {name}", category_case: "lower", font: "small_caps", emoji_mode: "all" }, "category", "Chat", "🌸", "꒰ 🌸 ꒱ ᴄʜᴀᴛ"],
  ];
  for (const [label, patch, kind, base, emoji, expected] of table) {
    it(`${label}: ${kind} "${base}" → "${expected}"`, () => {
      assert.equal(formatName(n(patch), kind, base, emoji), expected);
    });
  }

  it("truncates long names to 100 code points", () => {
    assert.equal(Array.from(formatName(n(), "text", "a".repeat(140), "")).length, 100);
  });
});

describe("presets", () => {
  it("ships at least 12 named presets with valid patterns", () => {
    assert.ok(NAMING_PRESETS.length >= 12);
    const ids = new Set(NAMING_PRESETS.map((p) => p.id));
    assert.equal(ids.size, NAMING_PRESETS.length);
    for (const p of NAMING_PRESETS) {
      for (const key of ["channel_pattern", "category_pattern", "voice_pattern"] as const) assert.ok(validPattern(p.naming[key]), `${p.id}.${key}`);
    }
    for (const id of ["clean", "emoji_bar", "emoji_dot", "brackets", "aesthetic", "minimal_caps", "lined", "boxed", "stars", "cozy", "gamer", "professional"]) {
      assert.ok(namingPreset(id), id);
    }
  });

  it("renders the preset samples the site shows", () => {
    const sample = (id: string) => {
      const p = namingPreset(id)!.naming;
      return [formatName(p, "text", "general chat", "💬"), formatName(p, "voice", "chill lounge", "🎧"), formatName(p, "category", "community hub", "🌿")];
    };
    assert.deepEqual(sample("clean"), ["general-chat", "Chill Lounge", "COMMUNITY HUB"]);
    assert.deepEqual(sample("emoji_bar"), ["💬｜general-chat", "🎧｜Chill Lounge", "🌿 COMMUNITY HUB"]);
    assert.deepEqual(sample("brackets"), ["「💬」general-chat", "「🎧」Chill Lounge", "「COMMUNITY HUB」"]);
    assert.deepEqual(sample("aesthetic"), ["╭・💬︰ɢᴇɴᴇʀᴀʟ-ᴄʜᴀᴛ", "🎧︰ᴄʜɪʟʟ ʟᴏᴜɴɢᴇ", "꒰ 🌿 ꒱ ᴄᴏᴍᴍᴜɴɪᴛʏ ʜᴜʙ"]);
    assert.deepEqual(sample("boxed"), ["💬・general-chat", "🎧 Chill Lounge", "【🌿 COMMUNITY HUB】"]);
    assert.deepEqual(sample("cozy"), ["💬-general︲chat", "🎧 Chill Lounge", "🌿 Community Hub"]);
    assert.deepEqual(sample("gamer"), ["┃💬┃general-chat", "┃🎧┃Chill Lounge", "▬ COMMUNITY HUB ▬"]);
    assert.deepEqual(sample("professional"), ["general-chat", "Chill Lounge", "Community Hub"]);
  });

  it("matches a naming back to its preset", () => {
    assert.equal(matchNamingPreset(namingPreset("emoji_bar")!.naming), "emoji_bar");
    assert.equal(matchNamingPreset({ channel_pattern: "{emoji}・{name}", category_pattern: "── {name} ──" }), null);
  });
});

describe("validPattern", () => {
  it("needs {name} exactly once and ≤ 30 decoration characters", () => {
    assert.ok(validPattern("{emoji}｜{name}"));
    assert.ok(!validPattern("{emoji}"));
    assert.ok(!validPattern("{name}{name}"));
    assert.ok(!validPattern(`${"✦".repeat(31)}{name}`));
    assert.equal(decorationLength("╭・{emoji}︰{name}"), 3);
  });
});
