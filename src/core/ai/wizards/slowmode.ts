/**
 * Autopilot wizard for Slowmode: the plugin-level settings plus any number of per-user or per-role
 * rules (zSlowmodeConfig / zSlowmodeRule). A rule for a user or role that already has one replaces
 * it on the dashboard instead of adding a duplicate.
 */
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  entityList,
  idRef,
  int,
  nullable,
  obj,
  oneOf,
  progressInstruction,
  turnSchemaWithIds,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { MAX_RULES_PER_RUN, boolOrNull, isRow } from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;
const SNOWFLAKE = /^[0-9]{17,20}$/;

function slowmodeRuleSchema(): Record<string, unknown> {
  return obj({
    target: oneOf(["user", "role"]),
    target_id: { anyOf: [idRef("role"), { type: "string", pattern: SNOWFLAKE.source }] },
    seconds: int(),
    channels: { type: "array", items: { anyOf: [{ type: "string", enum: ["*"] }, idRef("text_channel")] } },
  });
}

function slowmodeSchema(): Record<string, unknown> {
  return obj({
    default_seconds: nullable(int()),
    individual_enabled: nullable(bool()),
    allow_manage_messages_bypass: nullable(bool()),
    individual_default_seconds: nullable(int()),
    rules: { type: "array", items: slowmodeRuleSchema() },
  });
}

export const slowmodeWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  buildResultSchema: (ctx) => turnSchemaWithIds(slowmodeSchema(), ctx),
  validateConfig: (config, ctx) => {
    config.default_seconds = clampInt(config.default_seconds, 0, 21_600);
    config.individual_enabled = boolOrNull(config.individual_enabled);
    config.allow_manage_messages_bypass = boolOrNull(config.allow_manage_messages_bypass);
    config.individual_default_seconds = clampInt(config.individual_default_seconds, 0, 21_600);

    const roleIds = new Set(ctx.roles.map((r) => r.id));
    const textIds = new Set(ctx.textChannels.map((c) => c.id));
    const byTarget = new Map<string, Record<string, unknown>>();
    const raw = Array.isArray(config.rules) ? config.rules.filter(isRow) : [];
    let dropped = 0;
    for (const rule of raw.slice(0, MAX_RULES_PER_RUN)) {
      const target = rule.target === "role" || rule.target === "user" ? rule.target : null;
      const targetId = typeof rule.target_id === "string" ? rule.target_id.trim() : "";
      const seconds = clampInt(rule.seconds, 1, 21_600);
      const validTarget =
        target === "role" ? roleIds.has(targetId) : target === "user" && SNOWFLAKE.test(targetId) && !roleIds.has(targetId);
      if (!validTarget || seconds === null) {
        dropped++;
        continue;
      }
      const given = Array.isArray(rule.channels) ? rule.channels.filter((c): c is string => typeof c === "string") : [];
      const picked = [...new Set(given.filter((c) => textIds.has(c)))];
      let channels: string[];
      if (given.length === 0 || given.includes("*")) channels = ["*"];
      else if (picked.length) channels = picked;
      else {
        // Every channel it named was unknown; don't silently widen it to all channels.
        dropped++;
        continue;
      }
      byTarget.set(`${target}:${targetId}`, { target, target_id: targetId, seconds, channels });
    }
    config.rules = [...byTarget.values()];

    const settingsChanged = ["default_seconds", "individual_enabled", "allow_manage_messages_bypass", "individual_default_seconds"].some(
      (key) => config[key] !== null,
    );
    if (!settingsChanged && byTarget.size === 0) {
      return dropped
        ? "Autopilot picked a member, role, or channel that doesn't exist. Please try again."
        : "Autopilot didn't change anything. Please try again.";
    }
    return null;
  },
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Slowmode in Dreamliner. It has two parts: " +
    "(1) the default delay the /slowmode command applies to a channel when no duration is given " +
    "(default_seconds, 0 to 21600, uses Discord's own channel slowmode), and (2) individual " +
    "slowmode, a bot-enforced wait between messages for specific members or roles " +
    "(individual_enabled turns it on or off; individual_default_seconds, 0 to 21600, is the " +
    "fallback wait for everyone when no rule matches, 0 means none; " +
    "allow_manage_messages_bypass lets members with Manage Messages skip it). Rules give one member " +
    "or one role its own wait (seconds, 1 to 21600) in all channels or only some channels. " +
    `You are setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language ` +
    "question at a time. Never mention field names, JSON, or config, ask like a helpful person " +
    "would. Find out what they want slowed down (everyone, a role, or a particular member), how " +
    "long the wait should be, and where. Never tell the user one of these options is unsupported.\n\n" +
    "Rules: target is \"role\" or \"user\". For a role, target_id is a role id from the list below. " +
    "For a member, target_id is their numeric Discord user id (17 to 20 digits), taken from the " +
    "user's answer, a <@123...> mention, or imported notes; if you only have a username, ask for " +
    "the user id (Developer Mode, right click, Copy User ID) instead of guessing. channels is " +
    "[\"*\"] for all channels, or a list of channel ids from the list below. " +
    `You can return several rules at once (up to ${MAX_RULES_PER_RUN}), one per member or role; ` +
    "a rule for a member or role that already has one replaces it. Use an empty rules list when " +
    "only the settings change. Leave each plugin setting null unless the user brought it up " +
    "(for example, adding a role rule does not need individual_default_seconds).\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (role target_id must be one of these ids):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels (rule channels must be these ids, or \"*\" for all):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of what you set up " +
    "(leave question null).",
};
