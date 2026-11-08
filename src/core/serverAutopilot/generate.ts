/**
 * Server Autopilot generation: three parallel AI calls, one per "direction", each producing one
 * complete server template. Every template goes through sanitizeTemplate + normalizeTemplate, so
 * whatever the model returns, what the dashboard receives is valid and buildable.
 */
import type { Guild } from "discord.js";
import { generateStructured } from "../ai/client.js";
import { refundFreeAiUse } from "../ai/usage.js";
import { COLOR_RULE, NEVER_EM_DASH_RULE, bool, int, nullable, obj, oneOf, str } from "../ai/wizardKit.js";
import { getLogger } from "../logger.js";
import { aiMayPickNaming, namingOf, type SAAnswers } from "./answers.js";
import { detectNaming } from "./detect.js";
import { NAMING_PRESETS, formatName } from "./naming.js";
import { PERMISSION_FLAGS } from "./permissions.js";
import { snapshotGuild, structureOf, type GuildSnapshot } from "./snapshot.js";
import { getGeneration, updateGeneration } from "./store.js";
import { normalizeTemplate, sanitizeTemplate } from "./template.js";
import {
  SA_ACCESS,
  SA_CATEGORY_CASES,
  SA_CHANNEL_CASES,
  SA_CHANNEL_TYPES,
  SA_EMOJI_MODES,
  SA_FONTS,
  SA_LIMITS,
  SA_MESSAGE_KINDS,
  SA_PLUGIN_LEVELS,
  SA_PLUGINS,
  SA_PURPOSES,
  SA_ROLE_PRESETS,
  SA_SEPARATORS,
  SA_VOICE_CASES,
  type SATemplate,
} from "./types.js";

const log = getLogger("server_autopilot");

// ── JSON schema (OpenAI strict mode) ────────────────────────────────────────

const arrOf = (items: Record<string, unknown>) => ({ type: "array", items });

const CHANNEL_SCHEMA = obj({
  key: str(),
  base: str(),
  emoji: str(),
  type: oneOf(SA_CHANNEL_TYPES),
  topic: str(),
  slowmode: int(),
  nsfw: bool(),
  user_limit: int(),
  access: oneOf(SA_ACCESS),
  role_keys: arrOf(str()),
  purpose: oneOf(SA_PURPOSES),
});

const NAMING_SCHEMA = obj({
  channel_case: oneOf(SA_CHANNEL_CASES),
  separator: oneOf(SA_SEPARATORS),
  channel_pattern: str(),
  category_pattern: str(),
  category_case: oneOf(SA_CATEGORY_CASES),
  voice_pattern: str(),
  voice_case: oneOf(SA_VOICE_CASES),
  font: oneOf(SA_FONTS),
  emoji_mode: oneOf(SA_EMOJI_MODES),
});

export const TEMPLATE_SCHEMA: Record<string, unknown> = obj({
  name: str(),
  tagline: str(),
  summary: str(),
  highlights: arrOf(str()),
  naming: { anyOf: [{ type: "null" }, NAMING_SCHEMA] },
  roles: arrOf(
    obj({
      key: str(),
      name: str(),
      color: nullable(int()),
      hoist: bool(),
      mentionable: bool(),
      preset: oneOf(SA_ROLE_PRESETS),
      extra_permissions: arrOf(oneOf(PERMISSION_FLAGS)),
      self_assignable: bool(),
      group: str(),
    }),
  ),
  categories: arrOf(
    obj({
      key: str(),
      base: str(),
      emoji: str(),
      access: oneOf(SA_ACCESS),
      role_keys: arrOf(str()),
      channels: arrOf(CHANNEL_SCHEMA),
    }),
  ),
  uncategorized: arrOf(CHANNEL_SCHEMA),
  plugins: arrOf(
    obj({
      plugin: oneOf(SA_PLUGINS),
      channel_key: nullable(str()),
      role_key: nullable(str()),
      extra_role_keys: arrOf(str()),
      level: oneOf(SA_PLUGIN_LEVELS),
    }),
  ),
  messages: arrOf(
    obj({
      key: str(),
      channel_key: str(),
      kind: oneOf(SA_MESSAGE_KINDS),
      title: str(),
      body: str(),
      color: nullable(int()),
      role_group: str(),
    }),
  ),
});

// ── Prompt pieces ───────────────────────────────────────────────────────────

const SIZE_TARGETS: Record<SAAnswers["audience"]["size"], { channels: [number, number]; categories: [number, number]; label: string }> = {
  tiny: { channels: [8, 15], categories: [2, 4], label: "a tiny server (under 25 people)" },
  small: { channels: [14, 24], categories: [3, 5], label: "a small server (25 to 200 people)" },
  medium: { channels: [20, 32], categories: [4, 7], label: "a medium server (200 to 2,000 people)" },
  large: { channels: [28, 45], categories: [5, 9], label: "a large server (2,000 to 20,000 people)" },
  huge: { channels: [40, 60], categories: [7, 12], label: "a huge server (20,000+ people)" },
};

const VOICE_TARGETS: Record<SAAnswers["voice"]["amount"], string> = {
  none: "no voice channels at all",
  few: "1 to 2 voice channels",
  some: "3 to 5 voice channels",
  lots: "6 to 10 voice channels",
};

export type Direction = { id: "a" | "b" | "c"; label: string; brief: string };

/** The three directions, adapted to the answers (a tiny server's "expansive" is still small). */
export function directionsFor(answers: SAAnswers): Direction[] {
  const [low, high] = SIZE_TARGETS[answers.audience.size].channels;
  const mid = Math.round((low + high) / 2);
  return [
    {
      id: "a",
      label: "Balanced",
      brief:
        `DIRECTION A, "balanced": the closest possible match to the answers, nothing more and nothing less. ` +
        `Aim for about ${mid} channels in total. Every requested feature gets a home, nothing unrequested is added except essentials ` +
        "(rules, a general chat and staff areas when there are staff roles).",
    },
    {
      id: "b",
      label: "Compact",
      brief:
        `DIRECTION B, "compact and minimal": fewer, broader channels that keep conversation in one place. Aim for about ${Math.max(5, low - 2)} to ${low + 2} channels. ` +
        "Merge related ideas (one media channel instead of separate pics, clips and art; one voice lounge per purpose), keep the role list short, " +
        "prefer 3 to 4 categories. Still cover every requested feature, just leaner. A server that feels alive with few people.",
    },
    {
      id: "c",
      label: "Expansive",
      brief:
        `DIRECTION C, "expansive and feature-rich": a fuller, more ambitious layout. Aim for about ${high} to ${Math.min(SA_LIMITS.channels, high + 6)} channels. ` +
        "Add thoughtful extras that fit the server type (topic channels, a forum for longer discussions or showcases when it fits, events, " +
        "more self-role groups, engagement channels), while staying coherent and never padding with filler.",
    },
  ];
}

function listOrNone(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}

/** A compact description of the server as it is now, for the prompt. */
export function describeExisting(snap: GuildSnapshot): string {
  const structure = structureOf(snap);
  const lines: string[] = [];
  let shown = 0;
  for (const ch of structure.uncategorized) {
    if (shown++ > 70) break;
    lines.push(`  (no category) [${ch.type}] ${ch.name}`);
  }
  for (const cat of structure.categories) {
    if (shown++ > 70) break;
    lines.push(`  ${cat.name}`);
    for (const ch of cat.channels) {
      if (shown++ > 70) break;
      lines.push(`    [${ch.type}] ${ch.name}`);
    }
  }
  const roles = structure.roles.filter((r) => !r.managed).slice(0, 40).map((r) => r.name);
  if (!lines.length && !roles.length) return "The server is empty right now.";
  return `Current channels:\n${lines.join("\n") || "  (none)"}\nCurrent roles (highest first): ${listOrNone(roles)}`;
}

function namingBrief(answers: SAAnswers): string {
  const naming = namingOf(answers);
  const sample = (kind: "text" | "voice" | "category", base: string, emoji: string) => formatName(naming, kind, base, emoji);
  if (aiMayPickNaming(answers)) {
    return (
      "NAMING: the manager let Autopilot pick the naming style. Fill `naming` with a style that suits the vibe. Patterns use the tokens " +
      "{emoji} and {name}, must contain {name} exactly once and at most 30 characters of decoration. Good examples: " +
      NAMING_PRESETS.map((p) => `${p.label} (channels "${p.naming.channel_pattern}", categories "${p.naming.category_pattern}")`).join("; ") +
      "."
    );
  }
  return (
    "NAMING: the manager already chose a naming style, so set `naming` to null. Dreamliner formats every name itself from your `base` and " +
    `\`emoji\`, for example a text channel becomes "${sample("text", "general chat", "💬")}", a voice channel "${sample("voice", "chill lounge", "🎧")}" ` +
    `and a category "${sample("category", "community", "🌿")}".`
  );
}

const PURPOSE_HELP =
  "Purposes (pick the closest for every channel, it powers plugin setup and merging): rules, announcements, updates (changelogs), welcome, " +
  "introductions, verify, roles (self-role picker), faq, general, off_topic, media, memes, art, clips, events, giveaways, polls, suggestions, " +
  "tickets (support), starboard, counting, bot_commands, music (music bot commands), lfg, gaming, study, resources, links, partners, self_promo, " +
  "birthdays, leveling, qotd, staff_chat, logs, mod_logs, voice_lounge, voice_gaming, voice_music, voice_study, afk, stage, other.";

const ACCESS_HELP =
  "Access levels: everyone (normal), read_only (everyone reads, only staff post: rules, announcements, info), staff_only (hidden, staff roles see it), " +
  "verified_only (hidden until the member has the verified role), roles (everyone sees it, only role_keys post), hidden_roles (only role_keys see it). " +
  "A channel with access everyone inherits its category's access, so set access on the category and leave channels on everyone unless they differ.";

const ROLE_HELP =
  "Role presets decide permissions (Dreamliner applies them safely, never Administrator): owner, admin, moderator, helper, staff (generic team), member, " +
  "verified, vip, booster_like (supporters), muted, cosmetic (colour or flair only), ping (notification roles members opt into, mentionable), bot. " +
  "extra_permissions is only for genuine needs (for example ManageEvents for an event team); usually leave it empty. " +
  "Order roles from highest to lowest exactly like Discord's role list: owner, admin, moderator, helper and other staff teams, then special " +
  "member tiers (vip, booster_like), then colour roles, then regular member tiers (regular, member, verified), then self roles (pronouns, regions, pings), muted last. " +
  "Hoist staff and notable tiers so they show separately in the member list; never hoist self roles. Self roles (self_assignable true) need a group " +
  "name such as \"Pronouns\", \"Pings\", \"Colors\", \"Regions\", \"Games\" and are picked by members from a role picker message.";

const MESSAGE_HELP =
  "Starter messages are posted as embeds by Dreamliner: write the body in Discord markdown (bold, bullet lists, short paragraphs, \"## \" headings are fine), " +
  "at most 3500 characters, in the chosen language and tone. Link channels with {#channel_key} and roles with {@role_key} using the template keys; " +
  "Dreamliner turns them into real mentions. Kinds: rules (numbered, clear, matching the strictness and age rules), welcome_info (what the server is, " +
  "where to start, linking key channels), role_picker (one short line inviting members to pick roles; Dreamliner adds one button per self role of " +
  "role_group automatically), faq (4 to 6 real questions with answers), announcement_intro (what gets posted there and which ping role to grab), " +
  "staff_guide (how the team works: where to talk, how to handle reports, logs location). Only write the kinds the manager asked for.";

function pluginHelp(answers: SAAnswers): string {
  const wanted = answers.plugins.wanted;
  return (
    `Dreamliner plugins to set up: ${listOrNone(wanted)}. ` +
    (answers.plugins.auto ? "The manager also lets you add other fitting plugins from the list. " : "Only set up exactly those. ") +
    "For each plugin entry point channel_key at the template channel it uses (welcome_message: the welcome channel; logs, automod: the private log channel; " +
    "tickets: the support channel, role_key the support or moderator role; starboard, counting, suggestions, birthdays, giveaways: their own channels; " +
    "passport: the verify channel with role_key the verified role; autorole: role_key the member role given on join, never a staff role; " +
    "activity_rewards: the leveling channel; invite_tracker: the log channel; role_panels: the roles channel). level is the automod strength " +
    "(light, standard, strict), use standard for other plugins. Every plugin that needs a channel must have that channel in the template."
  );
}

const QUALITY_RULES = [
  "Design like the best organised real Discord servers: categories flow from information (rules, announcements, welcome, roles, faq) to community chat, " +
    "then topic channels for this server type, then events and media, then voice, with the staff area last.",
  "Every category has 2 or more channels (only the info category may be very short), no duplicate purposes unless the server type truly needs " +
    "several (for example one channel per game), and no near-duplicates like general and chat in the same server.",
  "Channel `base` is plain words only: lowercase, 1 to 3 words, no emoji, no symbols, no dashes, no numbering, ideally under 22 characters. " +
    "Category `base` is 1 to 3 plain words. Keys are short unique English slugs (lowercase letters, digits, underscores) and never change meaning.",
  "Give every channel and category exactly one standard Unicode emoji, never a custom emoji. Keep the emoji family consistent with the vibe " +
    "(for example soft nature emoji for a cozy server, sharp neon ones for a gaming server) and pick emoji that clearly say what the channel is.",
  "Write every channel base, topic, category base, role name, highlight and starter message in the chosen language (keys stay English). " +
    "Topics are one helpful sentence (under 120 characters) saying what belongs in the channel; voice channels have an empty topic.",
  "Staff, log and moderation channels are never visible to normal members. Info channels are read_only. Use voice user_limit only for small rooms " +
    "(duos, squads, study booths), otherwise 0. Use slowmode only for busy or self-promotion channels (5 to 30 seconds, self promotion 3600). " +
    "Only mark a channel nsfw when the manager allowed it and the server is 18+.",
  "Announcement, forum and stage channel types are fine to use: Dreamliner converts them when the server can't have them.",
  "Use role_keys only with access roles or hidden_roles (for example a channel only VIPs can see), and only reference keys that exist in this template.",
  "The template name is catchy and short (2 to 4 words, no server name), the tagline is under 80 characters, the summary explains in 2 sentences why it " +
    "fits, and highlights are 3 to 5 short bullets naming what makes this layout different from the other directions.",
];

function answersBrief(answers: SAAnswers, guildName: string): string {
  const b = answers.basics;
  const type = b.type === "custom" ? b.type_custom || "custom" : b.type;
  const size = SIZE_TARGETS[answers.audience.size];
  const lines = [
    `Server name: ${b.server_name || guildName}`,
    `Server type: ${type}`,
    b.description ? `What it's about: ${b.description}` : "",
    `Language: ${b.language || "English"}`,
    `Audience: ${size.label}, age ${answers.audience.age === "18plus" ? "18+ only" : answers.audience.age === "13plus" ? "13+" : "all ages"}${answers.audience.region ? `, region ${answers.audience.region}` : ""}`,
    `Size target: ${size.channels[0]} to ${size.channels[1]} channels in ${size.categories[0]} to ${size.categories[1]} categories (respect this).`,
    `Vibe: ${listOrNone(answers.vibe.mood)}; palette ${answers.vibe.palette}${answers.vibe.brand_color !== null ? `, brand colour ${answers.vibe.brand_color}` : ""}`,
    `Requested features: ${listOrNone(answers.features)}`,
    answers.feature_notes ? `Feature notes: ${answers.feature_notes}` : "",
    `Voice: ${VOICE_TARGETS[answers.voice.amount]}` +
      (answers.voice.amount === "none"
        ? ""
        : `; kinds wanted: ${listOrNone(
            (["lounges", "gaming", "music", "study", "afk", "stage", "private_rooms"] as const).filter((k) => answers.voice[k]).map((k) => k.replace("_", " ")),
          )}`),
    `Staff roles: ${listOrNone(answers.roles.staff)}`,
    `Member roles: ${listOrNone(answers.roles.member)}`,
    `Self-role groups: ${listOrNone(answers.roles.self_roles)}`,
    answers.roles.custom ? `Custom role requests: ${answers.roles.custom}` : "",
    `Role name style: ${
      {
        plain: 'plain names ("Moderator")',
        emoji_prefix: 'emoji first ("🛡️ Moderator")',
        emoji_suffix: 'emoji last ("Moderator 🛡️")',
        decorated: 'decorated with one consistent symbol on both sides ("⋆ Moderator ⋆")',
      }[answers.roles.role_style]
    }; apply it to every role name you write.`,
    `Moderation: ${answers.moderation.strictness}; verification ${answers.moderation.verification}; NSFW ${answers.moderation.nsfw_allowed ? "allowed" : "not allowed"}; ` +
      `info channels ${answers.moderation.read_only_info ? "read-only" : "open"}; slowmode on busy channels ${answers.moderation.slowmode_busy_channels ? "yes" : "no"}`,
    `Starter messages wanted: ${listOrNone(answers.messages.wanted)} (tone: ${answers.messages.tone})`,
    answers.notes ? `Other notes from the manager (follow them): ${answers.notes}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function existingBrief(answers: SAAnswers, snap: GuildSnapshot): string {
  const mode = answers.existing.mode;
  const detected = detectNaming({
    text: snap.channels.filter((c) => c.kind === "text" || c.kind === "announcement" || c.kind === "forum").map((c) => c.name),
    voice: snap.channels.filter((c) => c.kind === "voice" || c.kind === "stage").map((c) => c.name),
    categories: snap.channels.filter((c) => c.kind === "category").map((c) => c.name),
  });
  const modeText = {
    add: "The build will ADD what's missing and leave existing channels alone, so cover the purposes the server lacks and reuse existing purposes rather than duplicating them.",
    merge: "The build will MERGE: existing channels and roles with the same purpose or name are reused (renamed and moved, messages kept). Keep a purpose for each existing channel worth keeping so it can be matched.",
    fresh: "The build will start FRESH: anything not in your template is removed, so the template must be complete on its own.",
  }[mode];
  return `${describeExisting(snap)}\nDetected style: ${detected.summary}.\n${modeText}`;
}

export function buildPrompt(answers: SAAnswers, snap: GuildSnapshot, direction: Direction): { system: string; user: string } {
  const system = [
    "You are Server Autopilot, Dreamliner's expert Discord server architect. You design complete, coherent, genuinely great Discord server layouts " +
      "as JSON: categories, channels, roles, plugin setup and starter messages.",
    direction.brief,
    "Quality rules:",
    ...QUALITY_RULES.map((rule, i) => `${i + 1}. ${rule}`),
    PURPOSE_HELP,
    ACCESS_HELP,
    ROLE_HELP,
    MESSAGE_HELP,
    pluginHelp(answers),
    namingBrief(answers),
    `Hard limits: at most ${SA_LIMITS.roles} roles, ${SA_LIMITS.categories} categories, ${SA_LIMITS.channels} channels, ${SA_LIMITS.messages} starter messages. ` +
      "Voice user_limit 0 to 99, slowmode 0 to 21600 seconds, topics under 1024 characters.",
    COLOR_RULE + " Role colours should form a harmonious palette matching the vibe; ping, pronoun and region roles have color null.",
    NEVER_EM_DASH_RULE.replace("questions or summary", "names, topics, messages or summary"),
  ].join("\n\n");
  const user = `${answersBrief(answers, snap.name)}\n\n${existingBrief(answers, snap)}\n\nDesign the template now.`;
  return { system, user };
}

// ── Running a generation ────────────────────────────────────────────────────

export const GENERATION_MAX_TOKENS = 6000;

async function generateOne(answers: SAAnswers, snap: GuildSnapshot, direction: Direction, generationId: number): Promise<SATemplate> {
  const { system, user } = buildPrompt(answers, snap, direction);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generateStructured({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        schemaName: "server_template",
        schema: TEMPLATE_SCHEMA,
        maxTokens: GENERATION_MAX_TOKENS,
        model: process.env.SERVER_AUTOPILOT_MODEL?.trim() || undefined,
      });
      const sanitized = sanitizeTemplate(raw, namingOf(answers));
      sanitized.id = `g${generationId}_${direction.id}`;
      const { template } = normalizeTemplate(sanitized, answers);
      if (!template.categories.length && !template.uncategorized.length) throw new Error("The template came back without channels.");
      return template;
    } catch (error) {
      lastError = error;
      log.warn(`[server_autopilot] Template ${direction.id} attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Autopilot couldn't design this template.");
}

/** Runs a generation in the background, filling in the generation row as templates finish. */
export function runGeneration(guild: Guild, generationId: number, answers: SAAnswers): void {
  void (async () => {
    const snap = snapshotGuild(guild);
    const directions = directionsFor(answers);
    const results: SATemplate[] = [];
    let finished = 0;
    await Promise.all(
      directions.map(async (direction) => {
        try {
          const template = await generateOne(answers, snap, direction, generationId);
          results.push(template);
        } catch {
          /* counted below */
        } finally {
          finished += 1;
          results.sort((a, b) => a.id.localeCompare(b.id));
          updateGeneration(generationId, { templates: JSON.stringify(results), progress: finished });
        }
      }),
    );
    if (results.length) {
      updateGeneration(generationId, { status: "done", progress: directions.length, finishedAt: new Date() });
      return;
    }
    updateGeneration(generationId, {
      status: "failed",
      progress: directions.length,
      error: "Autopilot couldn't design any templates this time. Your Autopilot use was given back, please try again.",
      finishedAt: new Date(),
    });
    const row = getGeneration(guild.id, generationId);
    if (row?.charged) await refundFreeAiUse(guild.id).catch(() => null);
  })().catch(async (error) => {
    log.error(`[server_autopilot] Generation ${generationId} crashed:`, error);
    const row = getGeneration(guild.id, generationId);
    const hasTemplates = (() => {
      try {
        return (JSON.parse(row?.templates ?? "[]") as unknown[]).length > 0;
      } catch {
        return false;
      }
    })();
    updateGeneration(generationId, {
      status: hasTemplates ? "done" : "failed",
      error: hasTemplates ? null : "Something went wrong while generating. Your Autopilot use was given back, please try again.",
      progress: 3,
      finishedAt: new Date(),
    });
    if (!hasTemplates && row?.charged) await refundFreeAiUse(guild.id).catch(() => null);
  });
}
