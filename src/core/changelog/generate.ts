import { PLUGIN_DISPLAY } from "../helpCategories.js";
import type { ChatTurn } from "../ai/client.js";
import {
  buildUpdateTitle,
  CHANGELOG_ICONS,
  CHANGELOG_JSON_SCHEMA,
  contentLeaks,
  dropLeakyLines,
  formatUpdateDate,
  parseChangelogContent,
  promptCommitMessage,
  type ChangelogCommit,
  type ChangelogContent,
} from "./rules.js";

/**
 * Autopilot rewrites a release window's commits into release notes in the owner's Discord changelog
 * style, adapted for the website. A platform operation: no guild AI gate or usage counter.
 */

export const DEFAULT_CHANGELOG_MODEL = "gpt-4.1-mini";

export function changelogModel(): string {
  return process.env.CHANGELOG_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_CHANGELOG_MODEL;
}

/** Public product names Autopilot should use as written. */
const BRAND_NAMES = [
  "Autopilot (Dreamliner's AI features)",
  "Avia (the help centre and dashboard assistant)",
  "Ghost Mode",
  "The Hangar (formerly Plane Cards)",
  "Dreamliner One (the premium plan)",
  "Server Files",
  "Server Autopilot",
  "Custom Commands",
  "Message Kits",
  "Notifications",
  "Passport",
  "Global Watchdog",
  "Switch (importing from other bots)",
  "Clips",
  "Radio",
  "Store, Credits and Miles",
  "Progression badges",
  "Public Leaderboards",
];

/** The owner's real Discord changelog, with the Discord-only syntax removed. */
const STYLE_EXAMPLE = `Dreamliner Update 20/11/2026 - Notifications, Ghost Mode, Hangar and more
Summary: A major update bringing new collection systems, expanded notifications, improved moderation and greater control over your privacy.

[notifications] Notifications 2.0
Tagline: Everything in one place.
A unified notification system now supports YouTube, Twitch, RSS, Steam, GitHub releases, status pages and news feeds.
- Custom embeds, buttons and layouts
- Configurable sources and delivery channels
- Dashboard management and previews

[hangar] The Hangar
Tagline: Your collection, upgraded.
Plane Cards evolve into The Hangar, a full aircraft collection and trading experience.
- Numbered aircraft, rarity tiers and limited editions
- Packs, crafting, upgrades and custom liveries
- Player trading and community marketplace
- Flights, collection value and leaderboards

[ghost] Ghost Mode
Tagline: Take control of your visibility.
Hide live activity, opt out of global leaderboards and create trusted-viewer allowlists. Your statistics still track privately.

[leaderboard] Public Leaderboards
New global and server rankings for voice activity, daily streaks and Hangar fleet value, with improved caching and visibility controls.

[moderation] Community Management
Expanded dashboard tools for moderation timelines, incident statistics, bulk actions, application reviews, tickets and suggestions.
Also includes improved Passport verification, returning-member welcomes, contribution milestones and member identity tools.

[games] Community Features
Introducing Quizzes, with timed sessions, configurable questions, live answers and leaderboards.
Giveaways also gain recurring events, sponsors, entry requirements and improved draw history.

[commands] Custom Commands
New usage analytics show command activity, creators, total executions and last-used times, alongside improved editing and validation.

Smaller Improvements
- Better music recovery after Lavalink outages
- Improved voice reconnection
- More reliable AI character reviews
- Improved economy and streak handling
- Expanded dashboard APIs and integrations
- Additional security and performance improvements`;

export function buildChangelogSystemPrompt(): string {
  const catalogue = [...new Set(Object.values(PLUGIN_DISPLAY).map((p) => p.name))].join(", ");
  return [
    "You are Autopilot, writing the public release notes for Dreamliner, a Discord bot with a web dashboard.",
    "You receive the commits from one release window and turn them into a single update for the website changelog, in the style of the owner's Discord changelogs.",
    "",
    "Rules:",
    "- Write only from the commits given. Never invent features, numbers, limits, dates or prices. If a commit is vague, leave it out or fold it into a general line.",
    "- Never give a vague commit (e.g. 'Update x', 'fix', single letters) its own section; skip it or fold it into a general smaller improvement.",
    "- Describe fixes as fixes ('More reliable ...', 'Fixed ...'). Never say data was reset, removed or wiped unless a commit clearly says members will see that.",
    "- Group related commits into a few user-facing features (usually 2 to 6 sections). Put small fixes and polish in smallerImprovements.",
    "- Leave out pure refactors, chores, tests, formatting, dependency bumps, internal tooling and commits with meaningless messages.",
    "- Security fixes: describe them only generically, e.g. 'Additional security improvements'. Never describe a vulnerability or how it could be exploited.",
    "- Never mention file names, folders, environment variables, database migrations, function or variable names, commit hashes, people's names or email addresses.",
    "- Use the public product names below, written exactly as shown. Prefer the plugin catalogue names for plugins.",
    "- Never use internal or developer jargon: no 'bridge', 'endpoint', 'route', 'schema', 'database', 'migration', 'refactor', 'component ID', 'cache key', 'normalised to zero', 'watchdog timeout'. Say what changed for server owners and members, not how it was built.",
    "- Write in UK English (colour, organise, behaviour, localised, catalogue). Plain words, benefit-led, concise and confident.",
    "- Keep it short, like the reference: each paragraph is one or two sentences (under 40 words). Most sections have one paragraph; add a second only when it says something new.",
    "- Bullets never repeat the paragraph above them. Use 3 to 5 bullets for big features, none for small ones. smallerImprovements has at most 8 items.",
    "- No em dashes or en dashes, no emojis, no markdown, no exclamation marks.",
    "- Section names are short feature names (e.g. 'Notifications 2.0', 'Ghost Mode'). A tagline is optional: a short bold line like 'Everything in one place.' Use it only for the biggest features.",
    "- Bullets are short fragments without a full stop. Paragraphs are full sentences.",
    "- headline lists the 2 to 4 biggest features by their section names, most important first. summary is one sentence describing the whole update.",
    `- icon must be one of: ${CHANGELOG_ICONS.join(", ")}. Pick the closest (spark for general improvements, ai for Autopilot, Avia and characters, dashboard for website and dashboard tools, performance for speed and reliability, security for safety and privacy tools).`,
    "- If nothing in the window is user-facing, return empty sections and smallerImprovements.",
    "",
    `Public product names: ${BRAND_NAMES.join("; ")}.`,
    `Plugin catalogue: ${catalogue}.`,
    "",
    "Style reference (a real update; match its tone and structure, not its content):",
    STYLE_EXAMPLE,
  ].join("\n");
}

export function buildChangelogUserPrompt(input: { windowStart: number; windowEnd: number; commits: ChangelogCommit[] }): string {
  const lines = input.commits.slice(-80).map((commit) => {
    const date = commit.date.slice(0, 10);
    const areas = commit.areas?.length ? ` [areas: ${commit.areas.join(", ")}]` : "";
    const message = promptCommitMessage(commit.message).replace(/\n/g, "\n    ");
    return `- ${date}${areas}: ${message}`;
  });
  return [
    `Release window: ${new Date(input.windowStart).toISOString().slice(0, 10)} to ${new Date(input.windowEnd).toISOString().slice(0, 10)} (update dated ${formatUpdateDate(input.windowEnd)}).`,
    `Commits (${input.commits.length}, oldest first):`,
    ...lines,
  ].join("\n");
}

export type StructuredGenerator = (input: {
  messages: ChatTurn[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  model?: string;
}) => Promise<unknown>;

async function defaultGenerator(input: Parameters<StructuredGenerator>[0]): Promise<unknown> {
  const { generateStructured } = await import("../ai/client.js");
  return generateStructured(input);
}

/** Writes one update. Validates, cleans and leak-checks the result; retries once if it leaked. */
export async function generateChangelogContent(
  input: { windowStart: number; windowEnd: number; commits: ChangelogCommit[] },
  generator: StructuredGenerator = defaultGenerator,
): Promise<{ content: ChangelogContent; model: string }> {
  const model = changelogModel();
  const messages: ChatTurn[] = [
    { role: "system", content: buildChangelogSystemPrompt() },
    { role: "user", content: buildChangelogUserPrompt(input) },
  ];
  const call = async (turns: ChatTurn[]) =>
    parseChangelogContent(await generator({ messages: turns, schemaName: "changelog_update", schema: CHANGELOG_JSON_SCHEMA, maxTokens: 2500, model }));

  let content = await call(messages);
  const leaks = contentLeaks(content);
  if (leaks.length) {
    content = await call([
      ...messages,
      { role: "assistant", content: JSON.stringify(content) },
      { role: "user", content: `That draft mentions internal details (${leaks.join(", ")}). Rewrite it without them, following every rule.` },
    ]);
  }
  content = dropLeakyLines(content);
  const hasMore = content.sections.length > content.headline.length || content.smallerImprovements.length > 0;
  return { content: { ...content, title: buildUpdateTitle(input.windowEnd, content.headline, hasMore) }, model };
}
