/**
 * Autopilot pieces for Switch: moving a server from MEE6 or Dyno to Dreamliner. Neither bot has a
 * settings export, so the admin screenshots each page of their old dashboard. Autopilot first reads
 * the screenshots into plain notes (the only step that sees images), then the matching regular
 * setup wizard (AI_WIZARDS) runs in "import mode" seeded with those notes, so every plugin keeps
 * its own schema, validation and dashboard merge logic.
 */
import { generateStructured } from "./client.js";
import type { AiWizardContext } from "./wizards.js";

export const SWITCH_SOURCES = {
  mee6: { name: "MEE6", botId: "159985870458322944" },
  dyno: { name: "Dyno", botId: "155149108183695360" },
  yagpdb: { name: "YAGPDB", botId: "204255221017214977" },
  carl: { name: "Carl-bot", botId: "235148962103951360" },
  arcane: { name: "Arcane", botId: "437808476106784770" },
  probot: { name: "ProBot", botId: "282859044593598464" },
  tatsu: { name: "Tatsu", botId: "172002275412279296" },
} as const;

export type SwitchSource = keyof typeof SWITCH_SOURCES;

export function isSwitchSource(value: unknown): value is SwitchSource {
  return typeof value === "string" && value in SWITCH_SOURCES;
}

export const MAX_SWITCH_IMAGES = 4;

const NO_EM_DASH = "Never use em dashes; use a comma, period, or 'and' instead.";

/** How MEE6 and Dyno write their message variables, mapped to Dreamliner's placeholders. */
const VARIABLE_MAP =
  "Dreamliner message placeholders: {user} (mention), {user_display} (display name), {username}, {user_id}, " +
  "{server} (server name), {member_count}, {avatar_url}. Translate the old bot's variables into these: " +
  "MEE6 {user}, {user.mention} -> {user}; {user.name}, {user.username} -> {username}; {user.id} -> {user_id}; " +
  "{server}, {server.name} -> {server}; {server.member_count} -> {member_count}; {user.avatar_url} -> {avatar_url}. " +
  "Dyno {user} -> {user}; {username}, {user.username} -> {username}; {server} -> {server}; {avatar} -> {avatar_url}; " +
  "{everyone} -> @everyone; {here} -> @here; {&Role Name} -> the role mention <@&id> for that role; " +
  "{#channel-name} -> the channel mention <#id> for that channel. " +
  "Other bots use their own syntax; translate by meaning: YAGPDB Go templates ({{.User.Mention}} -> {user}, " +
  "{{.User.Username}} -> {username}, {{.Guild.Name}} -> {server}, {{.Guild.MemberCount}} -> {member_count}), " +
  "Carl-bot ({user} -> {user}, {user(name)} -> {username}, {server} -> {server}, {server(members)} -> {member_count}), " +
  "ProBot ([user] -> {user}, [userName] -> {username}, [server] -> {server}, [memberCount] -> {member_count}), " +
  "Arcane and Tatsu ({user} -> {user}, {server} -> {server}). If a variable has no equivalent, drop it and keep the sentence natural. " +
  "Always keep variables as placeholders; never replace one with its current value (write {server}, not the server's name).";

function entityNames(ctx: AiWizardContext): string {
  const channels = ctx.textChannels.map((c) => `#${c.name}`).join(", ") || "none";
  const roles = ctx.roles.map((r) => `@${r.name}`).join(", ") || "none";
  return `This server's text channels: ${channels}\nThis server's roles: ${roles}`;
}

export type SwitchReadResult = { looksRight: boolean; notes: string; problem: string | null };

const READ_SCHEMA = {
  type: "object",
  properties: {
    looks_right: { type: "boolean" },
    notes: { type: "string" },
    problem: { type: ["string", "null"] },
  },
  required: ["looks_right", "notes", "problem"],
  additionalProperties: false,
};

/**
 * Turns screenshots of one MEE6/Dyno dashboard page into plain-language setup notes: every
 * setting that's switched on, channels and roles by name, and messages copied word for word.
 */
export async function readSwitchScreenshots(input: {
  source: SwitchSource;
  categoryName: string;
  images: string[];
  ctx: AiWizardContext;
}): Promise<SwitchReadResult> {
  const bot = SWITCH_SOURCES[input.source].name;
  const system =
    `You read screenshots of the ${bot} Discord bot dashboard so a server admin can move their setup to Dreamliner. ` +
    `The screenshots should show the "${input.categoryName}" page. ` +
    "Write notes listing every setting you can see: which features and toggles are ON or OFF, every channel " +
    "(write #channel-name exactly as shown), every role (write @Role Name exactly as shown), numbers and limits, " +
    "selected options, emojis, and every message, embed title, description, footer and button label copied word " +
    "for word including any {variables}. Group the notes by section, one item per line, starting each line with " +
    "'- '. If a list has several entries (several roles, commands, rules, filters), list each entry separately and " +
    "number them. Ignore navigation menus, ads, upgrade prompts and anything greyed out behind a premium lock, " +
    "but mention if a feature is locked. Do not invent settings you can't see. " +
    `Set looks_right to false only if the screenshots clearly aren't the ${bot} "${input.categoryName}" page, ` +
    "and explain in one short sentence in problem (otherwise problem is null). " +
    NO_EM_DASH +
    "\n\n" +
    entityNames(input.ctx);

  const raw = (await generateStructured({
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Here ${input.images.length === 1 ? "is my screenshot" : `are my ${input.images.length} screenshots`} of the ${bot} "${input.categoryName}" page.`,
        images: input.images,
      },
    ],
    schemaName: "switch_read",
    schema: READ_SCHEMA,
    maxTokens: 2000,
  })) as { looks_right?: boolean; notes?: string; problem?: string | null };

  return {
    looksRight: raw.looks_right !== false,
    notes: (raw.notes ?? "").trim(),
    problem: raw.problem?.trim() || null,
  };
}

/**
 * Appended to a regular wizard's system prompt when it runs as part of a Switch import. The first
 * user turn carries the screenshot notes (and what's already been imported), so the wizard should
 * reproduce the old setup instead of interviewing the admin from scratch.
 */
export function buildImportDirective(source: SwitchSource, categoryName: string): string {
  const bot = SWITCH_SOURCES[source].name;
  return (
    "\n\nIMPORT MODE (this overrides the question-asking guidance above): the admin is switching from " +
    `${bot} to Dreamliner. Their first message contains notes read from screenshots of their ${bot} ` +
    `"${categoryName}" dashboard page. Reproduce that existing setup as faithfully as this Dreamliner setup ` +
    "allows, including every option the notes show (ignored channels and roles, exempt roles, word lists, limits, " +
    "actions, embeds, buttons and so on): Dreamliner supports far more than the questions above suggest, so map " +
    "everything the schema can express and never claim something is unsupported when a field for it exists. When " +
    "this setup can hold a list (rules, roles, tags, counters, milestones, categories), bring every entry over in " +
    "this one result and set more_to_import to false. When it holds a single item per run (one board, one panel, " +
    "one sticky), set up the first entry not in the 'Already imported' list and set more_to_import to true if other " +
    "entries remain. Leave settings the notes don't show as null. Match channels and roles by name to the ids above. Answer with action " +
    "\"ready\" straight away whenever the notes cover what's needed; only ask a question (at most one) when " +
    "something essential is missing or a named channel or role doesn't exist on this server. When the notes don't " +
    `show a setting, use what ${bot} does by default (for example no delay, no extra options) instead of asking. ` +
    "Never ask to confirm something the notes already state. Parts of the notes that belong to a different " +
    "Dreamliner feature (for example a join role while setting up welcome messages) are imported separately, so " +
    "ignore them here and don't mention them at all, not even to say they were left out. " +
    `Keep the summary to one or two sentences about what this setup brings over from ${bot}, and mention anything ` +
    "Dreamliner does differently. " +
    VARIABLE_MAP
  );
}

/**
 * Adds the import-only `more_to_import` flag to a wizard's strict turn schema. It goes before
 * `config`: the model writes keys in schema order, and having to add one more small key after a
 * large nested config object made it loop on whitespace until the token limit.
 */
export function withMoreToImport(schema: Record<string, unknown>): Record<string, unknown> {
  const { config, ...rest } = (schema.properties as Record<string, unknown>) ?? {};
  const properties = { ...rest, more_to_import: { type: "boolean" }, ...(config ? { config } : {}) };
  const required = [
    ...((schema.required as string[]) ?? []).filter((key) => key !== "config"),
    "more_to_import",
    ...(config ? ["config"] : []),
  ];
  return { ...schema, properties, required };
}
