import type { Client, GuildBan, GuildMember } from "discord.js";
import { userRegexMatches } from "../../../core/userRegex.js";
import {
  baseEmbed,
  codeBlock,
  commandHeader,
  discordTs,
  embedField,
  setEmbedAuthor,
  trimLines,
  type ResultContainer,
} from "../../../core/embeds.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

export const SEARCH_EMOJI = "<:icons_search:1544417406640726168>";

export type SearchSort = "name" | "joined" | "created" | "role";

export type SearchOptions = {
  query: string;
  page?: number;
  pageSize?: number;
  roles?: string[];
  inVoice?: boolean;
  botsOnly?: boolean;
  caseSensitive?: boolean;
  regex?: boolean;
  sort?: SearchSort;
  idsOnly?: boolean;
};

export type SearchResult = {
  members: GuildMember[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function matchQuery(text: string, query: string, caseSensitive: boolean, regex: boolean): boolean {
  if (!query) return true;
  if (regex) {
    return userRegexMatches(text, query, { caseInsensitive: !caseSensitive });
  }
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  return hay.includes(needle);
}

function memberMatches(member: GuildMember, opts: SearchOptions): boolean {
  const names = [member.user.username, member.displayName, member.user.globalName ?? ""].filter(Boolean);
  if (!opts.query) return true;
  return names.some((n) => matchQuery(n, opts.query, opts.caseSensitive ?? false, opts.regex ?? false));
}

function sortMembers(members: GuildMember[], sort: SearchSort): GuildMember[] {
  const sorted = [...members];
  switch (sort) {
    case "joined":
      sorted.sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
      break;
    case "created":
      sorted.sort((a, b) => a.user.createdTimestamp - b.user.createdTimestamp);
      break;
    case "role":
      sorted.sort((a, b) => b.roles.highest.position - a.roles.highest.position);
      break;
    case "name":
    default:
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return sorted;
}

export async function searchMembers(
  guild: import("discord.js").Guild,
  opts: SearchOptions,
): Promise<SearchResult> {
  const pageSize = opts.pageSize ?? 15;
  const page = Math.max(1, opts.page ?? 1);

  // Only request the full member list over the gateway (opcode 8) when the cache doesn't
  // already have everyone — search now runs on every Previous/Next click as well as the
  // initial command, and re-requesting on each click hits Discord's opcode-8 rate limit
  // (~1 request per guild per several seconds) almost immediately. A failed fetch still
  // leaves whatever's cached to search instead of throwing the whole page away.
  if (guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch().catch(() => null);
  }

  let members = [...guild.members.cache.values()].filter((m) => !m.user.bot || opts.botsOnly);

  if (opts.botsOnly) {
    members = members.filter((m) => m.user.bot);
  }

  if (opts.inVoice) {
    members = members.filter((m) => m.voice.channelId !== null);
  }

  if (opts.roles?.length) {
    members = members.filter((m) => opts.roles!.some((r) => m.roles.cache.has(r)));
  }

  members = members.filter((m) => memberMatches(m, opts));

  members = sortMembers(members, opts.sort ?? "name");

  const total = members.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    members: members.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

export type BanSearchResult = {
  bans: GuildBan[];
  total: number;
  page: number;
  totalPages: number;
  from: number;
  to: number;
};

export async function searchBans(guild: import("discord.js").Guild, opts: SearchOptions): Promise<BanSearchResult> {
  const pageSize = opts.pageSize ?? 15;
  const page = Math.max(1, opts.page ?? 1);

  const banCollection = await guild.bans.fetch();
  let bans = [...banCollection.values()];

  if (opts.query) {
    bans = bans.filter((b) => {
      return matchQuery(b.user.username, opts.query, opts.caseSensitive ?? false, opts.regex ?? false);
    });
  }

  bans.sort((a, b) => a.user.username.localeCompare(b.user.username));

  const total = bans.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    bans: bans.slice(start, start + pageSize),
    total,
    page: safePage,
    totalPages,
    from: start + 1,
    to: Math.min(start + pageSize, total),
  };
}

/** Raw ID dump for `ids_only` — the one search output that's meant to be copy-pasted elsewhere
 * (another tool, a script), so it stays plain text instead of the mention-based container every
 * other search response uses. */
export function formatSearchIds(result: SearchResult, t: Translator = defaultTranslator): string {
  const from = (result.page - 1) * result.pageSize + 1;
  const to = Math.min(result.page * result.pageSize, result.total);

  const header =
    result.total > result.pageSize
      ? t("utility.search.pageHeader", "**Page {page}** ({from}-{to}) (total {total})", {
          page: result.page,
          from,
          to,
          total: result.total,
        })
      : result.total === 1
        ? t("utility.search.foundOneMember", "Found 1 matching member")
        : t("utility.search.foundManyMembers", "Found {total} matching members", { total: result.total });

  if (result.members.length === 0) return header;

  return `${header}\n${codeBlock(result.members.map((m) => m.id).join(" "), "js")}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A member as `<@id>`, so it renders as a real, clickable mention with the member's current
 * name/nickname — instead of a stale plain-text snapshot of their username. Never pings: every
 * container built from this goes through `containerReply`/`containerEdit`, which default
 * `allowedMentions` to parse nothing (see NO_PING in core/responses.ts). */
function memberLine(member: GuildMember, sort: SearchSort, t: Translator = defaultTranslator): string {
  const mention = `<@${member.id}>`;
  if (sort === "joined" && member.joinedAt) {
    return t("utility.search.memberJoinedLine", "{mention} · joined {ts}", { mention, ts: discordTs(member.joinedAt) });
  }
  if (sort === "created") {
    return t("utility.search.memberCreatedLine", "{mention} · created {ts}", { mention, ts: discordTs(member.user.createdAt) });
  }
  return mention;
}

/** Pretty, paginated member search result — a Components V2 container with real (non-pinging)
 * mentions instead of the raw id/username codeblock `formatSearchPage` prints for `ids_only`. */
export function buildMemberSearchContainer(
  client: Client,
  guildConfig: GuildConfig,
  result: SearchResult,
  query: string,
  sort: SearchSort,
  t: Translator = defaultTranslator,
): ResultContainer {
  const from = (result.page - 1) * result.pageSize + 1;
  const lines = result.members.map((m, i) => `${from + i}. ${memberLine(m, sort, t)}`);

  const container = setEmbedAuthor(
    baseEmbed(),
    query ? t("utility.search.memberSearchQueryTitle", "Member Search: {query}", { query }) : t("utility.search.memberSearchTitle", "Member Search"),
    client,
    commandHeader(guildConfig, { emoji: SEARCH_EMOJI }),
  ).addFields(embedField(t("utility.search.resultsLabel", "Results"), trimLines(lines.join("\n"))));

  container.setFooter(
    result.totalPages > 1
      ? { text: t("utility.search.pageFooter", "Page {page} of {totalPages} · {total} total", { page: result.page, totalPages: result.totalPages, total: result.total }) }
      : {
          text:
            result.total === 1
              ? t("utility.search.oneMatchingMember", "1 matching member")
              : t("utility.search.manyMatchingMembers", "{total} matching members", { total: result.total }),
        },
  );

  return container;
}

/** Pretty, paginated ban search result — same shape as `buildMemberSearchContainer`. */
export function buildBanSearchContainer(
  client: Client,
  guildConfig: GuildConfig,
  bans: GuildBan[],
  page: number,
  totalPages: number,
  total: number,
  from: number,
  query: string,
  t: Translator = defaultTranslator,
): ResultContainer {
  const lines = bans.map(
    (b, i) => `${from + i}. <@${b.user.id}>${b.reason ? ` · ${truncate(b.reason, 80)}` : ""}`,
  );

  const container = setEmbedAuthor(
    baseEmbed(),
    query ? t("utility.search.banSearchQueryTitle", "Ban Search: {query}", { query }) : t("utility.search.banSearchTitle", "Ban Search"),
    client,
    commandHeader(guildConfig, { emoji: SEARCH_EMOJI }),
  ).addFields(embedField(t("utility.search.resultsLabel", "Results"), trimLines(lines.join("\n"))));

  container.setFooter(
    totalPages > 1
      ? { text: t("utility.search.pageFooter", "Page {page} of {totalPages} · {total} total", { page, totalPages, total }) }
      : {
          text:
            total === 1
              ? t("utility.search.oneMatchingBan", "1 matching ban")
              : t("utility.search.manyMatchingBans", "{total} matching bans", { total }),
        },
  );

  return container;
}
