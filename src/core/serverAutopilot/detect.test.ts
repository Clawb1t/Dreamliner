import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNaming, detectPurpose, detectRolePreset, isSensitiveName, normalizeName, unfont } from "./detect.js";

describe("normalizeName / unfont", () => {
  it("strips emoji, decoration and fonts", () => {
    assert.equal(normalizeName("📜︱server-rules"), "serverrules");
    assert.equal(normalizeName("╭・💬︰ɢᴇɴᴇʀᴀʟ"), "general");
    assert.equal(normalizeName("𝗚𝗲𝗻𝗲𝗿𝗮𝗹 𝟮"), "general2");
    assert.equal(normalizeName("ＧＥＮＥＲＡＬ"), "general");
    assert.equal(unfont("𝚖𝚘𝚗𝚘"), "mono");
  });
});

describe("detectPurpose", () => {
  const cases: Array<[string, Parameters<typeof detectPurpose>[1], string]> = [
    ["📜︱server-rules", "text", "rules"],
    ["rules", "text", "rules"],
    ["regeln", "text", "rules"],
    ["📢・announcements", "announcement", "announcements"],
    ["general", "text", "general"],
    ["General", "voice", "voice_lounge"],
    ["off-topic", "text", "off_topic"],
    ["bot-commands", "text", "bot_commands"],
    ["mod-logs", "text", "mod_logs"],
    ["staff-chat", "text", "staff_chat"],
    ["AFK", "voice", "afk"],
    ["Town Hall", "stage", "stage"],
    ["self-roles", "text", "roles"],
    ["memes", "text", "memes"],
    ["my-cool-channel", "text", "other"],
    ["Music", "voice", "voice_music"],
  ];
  for (const [name, kind, expected] of cases) {
    it(`${kind} "${name}" → ${expected}`, () => assert.equal(detectPurpose(name, kind), expected));
  }
  it("uses the topic weakly", () => {
    assert.equal(detectPurpose("read-me", "text", "Please read the rules before chatting"), "rules");
  });
});

describe("detectRolePreset", () => {
  it("recognises common staff and member names", () => {
    assert.equal(detectRolePreset("Mods"), "moderator");
    assert.equal(detectRolePreset("🛡️ Moderator"), "moderator");
    assert.equal(detectRolePreset("Administrator"), "admin");
    assert.equal(detectRolePreset("Founder"), "owner");
    assert.equal(detectRolePreset("Muted"), "muted");
    assert.equal(detectRolePreset("Cool Kids"), null);
  });
});

describe("detectNaming", () => {
  it("reads emoji + bar prefixes and uppercase categories", () => {
    const d = detectNaming({
      text: ["📜｜rules", "💬｜general", "😂｜memes", "🎮｜gaming-chat"],
      voice: ["🔊 Lounge", "🎮 Gaming"],
      categories: ["INFO", "COMMUNITY", "VOICE"],
    });
    assert.equal(d.naming.channel_pattern, "{emoji}｜{name}");
    assert.equal(d.naming.category_case, "upper");
    assert.equal(d.naming.voice_pattern, "{emoji} {name}");
    assert.equal(d.naming.emoji_mode, "channels");
    assert.match(d.summary, /emoji \+ ｜/);
  });
  it("detects plain servers as Clean", () => {
    const d = detectNaming({ text: ["general", "off-topic", "memes"], voice: ["General"], categories: ["Text Channels", "Voice Channels"] });
    assert.equal(d.naming.channel_pattern, "{name}");
    assert.equal(d.naming.emoji_mode, "none");
    assert.equal(d.naming.separator, "-");
  });
  it("detects framed categories and small caps", () => {
    const d = detectNaming({ text: ["ɢᴇɴᴇʀᴀʟ", "ᴍᴇᴍᴇꜱ", "ᴍᴇᴅɪᴀ"], voice: [], categories: ["── INFO ──", "── CHAT ──"] });
    assert.equal(d.naming.category_pattern, "── {name} ──");
    assert.equal(d.naming.font, "small_caps");
  });
  it("handles an empty server", () => {
    const d = detectNaming({ text: [], voice: [], categories: [] });
    assert.deepEqual(d.naming, {});
    assert.equal(d.preset, null);
  });
});

describe("isSensitiveName", () => {
  it("flags staff-side names", () => {
    for (const name of ["staff", "🛡️︱mod-chat", "admin", "ADMINISTRATION", "mod logs", "modlogs", "audit-log", "logs", "message logs", "management", "ᴍᴏᴅ ᴛᴀʟᴋ", "staff-announcements", "punishments"]) {
      assert.equal(isSensitiveName(name), true, name);
    }
  });
  it("leaves public names alone", () => {
    for (const name of ["general", "mods", "game-mods", "dev-logs", "patch logs", "staff-applications", "meet the staff", "staff list", "announcements", "modding help"]) {
      assert.equal(isSensitiveName(name), false, name);
    }
  });
});
