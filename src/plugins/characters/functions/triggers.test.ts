import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  channelAllowed,
  mentionsName,
  resolveCharacterTargets,
  shouldIgnoreMessage,
  type TriggerCharacter,
  type TriggerConfig,
  type TriggerMessage,
} from "./triggers.js";

const ROLE_A = "111111111111111111";
const ROLE_B = "222222222222222222";
const ROLE_C = "333333333333333333";
const CHANNEL = "400000000000000000";
const DEDICATED = "500000000000000000";
const WEBHOOK = "600000000000000000";

function character(id: number, name: string, extra: Partial<TriggerCharacter> = {}): TriggerCharacter {
  return { id, name, roleId: null, dedicatedChannelIds: [], allowedChannelIds: [], enabled: true, reviewStatus: "approved", ...extra };
}

const barnacle = character(1, "Captain Barnacle", { roleId: ROLE_A, dedicatedChannelIds: [DEDICATED] });
const librarian = character(2, "Wise Librarian", { roleId: ROLE_B });
const robot = character(3, "Bolt", { roleId: ROLE_C });
const all = [barnacle, librarian, robot];

function config(triggers: Partial<TriggerConfig["triggers"]> = {}, extra: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    allowed_channels: [],
    blocked_channels: [],
    triggers: { reply: true, name: false, dedicated_channels: true, ...triggers },
    ...extra,
  };
}

function message(content: string, extra: Partial<TriggerMessage> = {}): TriggerMessage {
  return {
    authorBot: false,
    webhookId: null,
    inGuild: true,
    system: false,
    content,
    channelId: CHANNEL,
    parentId: null,
    categoryId: null,
    nsfw: false,
    reference: null,
    ...extra,
  };
}

const notOwn = () => false;
const ids = (matches: { character: TriggerCharacter }[]) => matches.map((m) => m.character.id);

describe("characters triggers", () => {
  it("answers a role mention", () => {
    const matches = resolveCharacterTargets(message(`<@&${ROLE_A}> ahoy`), all, config(), notOwn);
    assert.deepEqual(ids(matches), [1]);
    assert.equal(matches[0]!.reason, "mention");
  });

  it("lets at most two characters answer, in mention order", () => {
    const matches = resolveCharacterTargets(message(`<@&${ROLE_C}> <@&${ROLE_A}> <@&${ROLE_B}> hi all`), all, config(), notOwn);
    assert.deepEqual(ids(matches), [3, 1]);
  });

  it("answers a reply to its own webhook message, but not to someone else's webhook", () => {
    const reply = message("and then?", { reference: { webhookId: WEBHOOK, authorName: "Wise Librarian" } });
    assert.deepEqual(ids(resolveCharacterTargets(reply, all, config(), (id) => id === WEBHOOK)), [2]);
    assert.deepEqual(ids(resolveCharacterTargets(reply, all, config(), notOwn)), []);
    assert.deepEqual(ids(resolveCharacterTargets(reply, all, config({ reply: false }), (id) => id === WEBHOOK)), []);
  });

  it("answers everything in a dedicated channel (and its threads) when that trigger is on", () => {
    assert.deepEqual(ids(resolveCharacterTargets(message("hello", { channelId: DEDICATED }), all, config(), notOwn)), [1]);
    const inThread = message("hello", { channelId: "700000000000000000", parentId: DEDICATED });
    assert.deepEqual(ids(resolveCharacterTargets(inThread, all, config(), notOwn)), [1]);
    assert.deepEqual(ids(resolveCharacterTargets(message("hello", { channelId: DEDICATED }), all, config({ dedicated_channels: false }), notOwn)), []);
  });

  it("matches names as whole words only, when the name trigger is on", () => {
    assert.equal(mentionsName("hey barnacle, what's up", "Captain Barnacle"), true);
    assert.equal(mentionsName("Captain Barnacle!", "Captain Barnacle"), true);
    assert.equal(mentionsName("so many barnacles here", "Captain Barnacle"), false);
    assert.equal(mentionsName("the captain said", "Captain Barnacle"), false, "common title words don't trigger alone");
    assert.equal(mentionsName("run `barnacle --help`", "Captain Barnacle"), false, "not inside code");
    assert.equal(mentionsName("```\nbolt\n```", "Bolt"), false);
    assert.deepEqual(ids(resolveCharacterTargets(message("bolt are you there"), all, config({ name: true }), notOwn)), [3]);
    assert.deepEqual(ids(resolveCharacterTargets(message("bolt are you there"), all, config(), notOwn)), []);
  });

  it("ignores bots, webhooks, DMs and system messages", () => {
    assert.equal(shouldIgnoreMessage({ authorBot: true, webhookId: null, inGuild: true, system: false }), true);
    assert.equal(shouldIgnoreMessage({ authorBot: false, webhookId: WEBHOOK, inGuild: true, system: false }), true);
    assert.equal(shouldIgnoreMessage({ authorBot: false, webhookId: null, inGuild: false, system: false }), true);
    assert.equal(shouldIgnoreMessage({ authorBot: false, webhookId: null, inGuild: true, system: true }), true);
    // Another character's message mentioning a role never triggers (no character-to-character loops).
    assert.deepEqual(ids(resolveCharacterTargets(message(`<@&${ROLE_A}>`, { webhookId: WEBHOOK }), all, config(), notOwn)), []);
    assert.deepEqual(ids(resolveCharacterTargets(message(`<@&${ROLE_A}>`, { authorBot: true }), all, config(), notOwn)), []);
  });

  it("skips disabled or rejected characters", () => {
    const off = [character(1, "Captain Barnacle", { roleId: ROLE_A, enabled: false }), character(2, "Wise Librarian", { roleId: ROLE_B, reviewStatus: "rejected" })];
    assert.deepEqual(ids(resolveCharacterTargets(message(`<@&${ROLE_A}> <@&${ROLE_B}>`), off, config(), notOwn)), []);
  });

  it("respects blocked, allowed and age-restricted channels", () => {
    const base = config();
    assert.equal(channelAllowed(barnacle, { channelId: CHANNEL, parentId: null, categoryId: null, nsfw: false }, base), true);
    assert.equal(channelAllowed(barnacle, { channelId: CHANNEL, parentId: null, categoryId: null, nsfw: true }, base), false);
    assert.equal(channelAllowed(barnacle, { channelId: CHANNEL, parentId: null, categoryId: null, nsfw: false }, { ...base, blocked_channels: [CHANNEL] }), false);
    const allowedElsewhere = { ...base, allowed_channels: ["800000000000000000"] };
    assert.equal(channelAllowed(barnacle, { channelId: CHANNEL, parentId: null, categoryId: null, nsfw: false }, allowedElsewhere), false);
    assert.equal(channelAllowed(barnacle, { channelId: DEDICATED, parentId: null, categoryId: null, nsfw: false }, allowedElsewhere), true, "dedicated always works");
    assert.equal(channelAllowed(barnacle, { channelId: CHANNEL, parentId: null, categoryId: "800000000000000000", nsfw: false }, allowedElsewhere), true, "categories count");
    const own = character(9, "Bolt", { allowedChannelIds: [CHANNEL] });
    assert.equal(channelAllowed(own, { channelId: CHANNEL, parentId: null, categoryId: null, nsfw: false }, allowedElsewhere), true, "per-character override");
  });
});
