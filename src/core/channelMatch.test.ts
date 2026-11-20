import { test } from "node:test";
import assert from "node:assert/strict";
import { channelInList, channelScopeIds, guildChannelScope, type ChannelScopeSource } from "./channelMatch.js";
import { musicChannelBlock } from "../plugins/music/functions/limits.js";
import { isIgnoredChannel } from "../plugins/activity_rewards/functions/config.js";
import { ruleAppliesToChannel } from "../plugins/slowmode/functions/rules.js";
import { autodeleteRuleFor } from "../plugins/autodelete/functions/config.js";

const CATEGORY = "100000000000000001";
const OTHER_CATEGORY = "100000000000000002";
const TEXT = "200000000000000001";
const VOICE = "200000000000000002";
const UNRELATED = "200000000000000003";
const THREAD = "300000000000000001";

const category: ChannelScopeSource = { id: CATEGORY, parentId: null, parent: null };
const text: ChannelScopeSource = { id: TEXT, parentId: CATEGORY, parent: category };
const voice: ChannelScopeSource = { id: VOICE, parentId: CATEGORY, parent: category };
const unrelated: ChannelScopeSource = { id: UNRELATED, parentId: OTHER_CATEGORY, parent: { id: OTHER_CATEGORY, parentId: null } };
const thread: ChannelScopeSource = { id: THREAD, parentId: TEXT, parent: text };
const uncategorised: ChannelScopeSource = { id: "200000000000000009", parentId: null, parent: null };

/** A guild channel cache that only knows its own channels. */
const guild = {
  channels: {
    cache: new Map<string, ChannelScopeSource>([category, text, voice, unrelated, thread].map((c) => [c.id, c])),
  },
};

test("channelScopeIds: channel, its category, and a thread's parent and category", () => {
  assert.deepEqual(channelScopeIds(text), [TEXT, CATEGORY]);
  assert.deepEqual(channelScopeIds(thread), [THREAD, TEXT, CATEGORY]);
  assert.deepEqual(channelScopeIds(uncategorised), [uncategorised.id]);
  assert.deepEqual(channelScopeIds(null), []);
});

test("channelInList matches a listed channel directly", () => {
  assert.equal(channelInList([TEXT], text), true);
  assert.equal(channelInList([TEXT], TEXT), true);
});

test("channelInList matches every channel in a listed category", () => {
  assert.equal(channelInList([CATEGORY], text), true);
  assert.equal(channelInList([CATEGORY], voice), true);
});

test("channelInList matches a thread through its parent channel or that channel's category", () => {
  assert.equal(channelInList([TEXT], thread), true);
  assert.equal(channelInList([CATEGORY], thread), true);
});

test("channelInList does not match unrelated channels, empty lists or bare ids of other channels", () => {
  assert.equal(channelInList([CATEGORY], unrelated), false);
  assert.equal(channelInList([CATEGORY], uncategorised), false);
  assert.equal(channelInList([], text), false);
  assert.equal(channelInList(undefined, text), false);
  assert.equal(channelInList([CATEGORY], null), false);
  // A bare id can't know its category, so it only matches itself.
  assert.equal(channelInList([CATEGORY], TEXT), false);
});

test("guildChannelScope resolves only from that guild's cache", () => {
  assert.equal(guildChannelScope(guild, TEXT), text);
  assert.deepEqual(guildChannelScope(guild, "999999999999999999"), { id: "999999999999999999" });
  assert.equal(guildChannelScope(guild, null), null);
  assert.equal(channelInList([CATEGORY], guildChannelScope(guild, "999999999999999999")), false);
});

test("music: an allowed category allows its voice and text channels", () => {
  const config = { allowed_voice_channels: [CATEGORY], allowed_text_channels: [CATEGORY] };
  assert.equal(musicChannelBlock(config, guild, VOICE, TEXT), null);
  assert.equal(musicChannelBlock(config, guild, VOICE, THREAD), null);
  assert.match(musicChannelBlock(config, guild, UNRELATED, TEXT) ?? "", /voice channel/);
  assert.match(musicChannelBlock(config, guild, VOICE, UNRELATED) ?? "", /this channel/);
  // Saved configs with plain channel ids keep working.
  assert.equal(musicChannelBlock({ allowed_voice_channels: [VOICE], allowed_text_channels: [] }, guild, VOICE, UNRELATED), null);
});

test("activity rewards: an ignored category ignores its channels and threads", () => {
  const config = { ignored_channels: [CATEGORY] };
  assert.equal(isIgnoredChannel(config, text), true);
  assert.equal(isIgnoredChannel(config, voice), true);
  assert.equal(isIgnoredChannel(config, thread), true);
  assert.equal(isIgnoredChannel(config, unrelated), false);
});

test("slowmode: a rule on a category applies in its channels and threads", () => {
  const rule = { id: 1, target: "role" as const, target_id: "1", seconds: 30, channels: [CATEGORY] };
  assert.equal(ruleAppliesToChannel(rule, text), true);
  assert.equal(ruleAppliesToChannel(rule, thread), true);
  assert.equal(ruleAppliesToChannel(rule, unrelated), false);
  assert.equal(ruleAppliesToChannel({ ...rule, channels: ["*"] }, unrelated), true);
});

test("autodelete: a category rule covers its channels, a channel's own rule wins, threads stay exact", () => {
  const rule = (channel_id: string, delay_seconds: number) => ({ enabled: true, name: "", channel_id, delay_seconds });
  const config = { rules: [rule(CATEGORY, 60), rule(VOICE, 5)] };
  assert.equal(autodeleteRuleFor(config, text)?.delay_seconds, 60);
  assert.equal(autodeleteRuleFor(config, voice)?.delay_seconds, 5);
  assert.equal(autodeleteRuleFor(config, unrelated), undefined);
  assert.equal(autodeleteRuleFor(config, { ...thread, isThread: () => true }), undefined);
});
