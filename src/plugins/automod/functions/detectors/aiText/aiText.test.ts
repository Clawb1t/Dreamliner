import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutomodRuleConfig } from "../../../../../config/schemas/automod.js";
import { aiTextThreshold, detectAiText, scoreAiText } from "./index.js";
import { extractFeatures, FEATURE_NAMES, prepareText } from "./features.js";
import { AI_TEXT_MODEL } from "./model.js";

const AI_REPLY = `Great question! Choosing the right GPU for 1440p gaming depends on several key factors, including your budget, the games you play, and your desired frame rates.

Here are some options to consider:

- **NVIDIA RTX 4070 Super:** Offers excellent performance at 1440p and supports DLSS 3, which can significantly boost frame rates.
- **AMD Radeon RX 7800 XT:** A strong value option with generous VRAM, making it well suited for modern titles.

Additionally, it's important to note that your CPU and monitor refresh rate play a crucial role in overall performance. Ultimately, the best choice will depend on your specific needs. I hope this helps, and feel free to ask if you have any other questions!`;

const AI_PARAGRAPH = `Learning a new language is a rewarding journey that requires consistency, patience, and the right approach. Furthermore, immersing yourself in the language through music, films, and conversation can significantly enhance your progress. It is essential to set realistic goals and track your improvement over time. Moreover, leveraging spaced repetition tools can help you retain vocabulary more effectively. Ultimately, the key to success lies in maintaining a steady routine and embracing mistakes as valuable learning opportunities.`;

const HUMAN_CHAT = `ok so i finally beat the fire giant last night after like 40 tries lol. honestly the trick was just summoning the npc and staying behind his left leg the whole time, he barely hits you there. my build is kinda janky tho, like 30 vigor and everything else in strength cause i found the greatsword early and just never let go of it haha. anyone else get stuck on him for ages or is it just me`;

const HUMAN_RANT = `idk man I tried the new update and it's kinda broken?? the menu keeps freezing when u open the inventory and my friend had the same thing happen. we both reinstalled and nope, still there. not trying to be that guy but they really should've tested this before pushing it out on a friday night of all times. anyway if anyone found a fix lmk, I'll try anything at this point`;

function rule(overrides: Partial<AutomodRuleConfig> = {}): AutomodRuleConfig {
  return {
    enabled: true,
    sensitivity: "balanced",
    strike_window_ms: 3_600_000,
    delete_message: false,
    points: 1,
    notify: false,
    log_silent_hits_as_cases: false,
    ignored_channels: [],
    ignored_roles: [],
    ladder: [{ after: 1, actions: [{ type: "none" }] }],
    settings: {},
    ...overrides,
  };
}

function messageCtx(content: string) {
  return { kind: "message", content, normalized: content.toLowerCase() } as unknown as Parameters<typeof detectAiText>[0];
}

test("the shipped model matches the feature list", () => {
  assert.equal(AI_TEXT_MODEL.weights.length, FEATURE_NAMES.length);
  assert.equal(AI_TEXT_MODEL.means.length, FEATURE_NAMES.length);
  assert.equal(AI_TEXT_MODEL.stds.length, FEATURE_NAMES.length);
  assert.ok(AI_TEXT_MODEL.samples > 1000, "model was trained on a real corpus");
});

test("typical assistant replies score high, casual chat scores low", () => {
  const ai = [AI_REPLY, AI_PARAGRAPH].map((text) => scoreAiText(text).score ?? 0);
  const human = [HUMAN_CHAT, HUMAN_RANT].map((text) => scoreAiText(text).score ?? 100);
  for (const score of ai) assert.ok(score >= 85, `AI sample scored ${score}`);
  for (const score of human) assert.ok(score < 50, `human sample scored ${score}`);
});

test("explains a high score with readable reasons", () => {
  const result = scoreAiText(AI_REPLY);
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.some((s) => /assistant phrasing/i.test(s.label)));
  assert.ok(result.signals.every((s) => !s.label.includes("—")));
});

test("short messages are never judged", () => {
  assert.equal(scoreAiText("Certainly! I hope this helps.").score, null);
  assert.equal(detectAiText(messageCtx("Certainly! Here is a comprehensive overview. I hope this helps."), rule()), null);
});

test("code blocks, quotes and links are ignored", () => {
  const prepared = prepareText("> quoted text here\n```js\nconst x = 1;\n```\nsee https://example.com/page ok");
  assert.ok(!prepared.text.includes("quoted"));
  assert.ok(!prepared.text.includes("const"));
  assert.ok(!prepared.text.includes("example.com"));
});

test("curly quotes from phone keyboards change nothing", () => {
  const straight = extractFeatures(prepareText(HUMAN_RANT));
  const curly = extractFeatures(prepareText(HUMAN_RANT.replace(/'/g, "’")));
  assert.deepEqual(curly, straight);
});

test("the detector fires with a likelihood and reasons in the detail", () => {
  const hit = detectAiText(messageCtx(AI_REPLY), rule());
  assert.ok(hit);
  assert.equal(hit.ruleId, "ai_text");
  assert.match(hit.detail ?? "", /^\d+% likely/);
  assert.equal(detectAiText(messageCtx(HUMAN_CHAT), rule()), null);
});

test("sensitivity and min_score move the threshold within 50 to 99", () => {
  assert.equal(aiTextThreshold(rule()), 85);
  assert.equal(aiTextThreshold(rule({ sensitivity: "lenient" })), 92);
  assert.equal(aiTextThreshold(rule({ sensitivity: "strict" })), 75);
  assert.equal(aiTextThreshold(rule({ settings: { min_score: 99 }, sensitivity: "lenient" })), 99);
  assert.equal(aiTextThreshold(rule({ settings: { min_score: 50 }, sensitivity: "strict" })), 50);
});
