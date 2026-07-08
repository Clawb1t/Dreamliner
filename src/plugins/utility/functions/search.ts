import type { GuildBan, GuildMember, User } from "discord.js";
import { getMemberLevel } from "../../../core/permissions.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { codeBlock } from "../../../core/embeds.js";

export type SearchSort = "name" | "joined" | "created" | "level";

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
    try {
      const flags = caseSensitive ? "" : "i";
      return new RegExp(query, flags).test(text);
    } catch {
      return false;
    }
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

function sortMembers(members: GuildMember[], sort: SearchSort, guildConfig: GuildConfig): GuildMember[] {
  const sorted = [...members];
  switch (sort) {
    case "joined":
      sorted.sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
      break;
    case "created":
      sorted.sort((a, b) => a.user.createdTimestamp - b.user.createdTimestamp);
      break;
    case "level":
      sorted.sort(
        (a, b) =>
          getMemberLevel(b, guildConfig.levels) - getMemberLevel(a, guildConfig.levels),
      );
      break;
    case "name":
    default:
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return sorted;
}

export async function searchMembers(
  guild: import("discord.js").Guild,
  guildConfig: GuildConfig,
  opts: SearchOptions,
): Promise<SearchResult> {
  const pageSize = opts.pageSize ?? 15;
  const page = Math.max(1, opts.page ?? 1);

  await guild.members.fetch();

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

  members = sortMembers(members, opts.sort ?? "name", guildConfig);

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

export async function searchBans(guild: import("discord.js").Guild, opts: SearchOptions) {
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

function formatMemberLine(member: GuildMember): string {
  const longest = member.id.length;
  const paddedId = member.id.padEnd(longest, " ");
  let line = `${paddedId} ${member.user.username}`;
  if (member.nickname) line += ` (${member.nickname})`;
  return line;
}

function formatUserLine(user: User): string {
  return `${user.id.padEnd(user.id.length, " ")} ${user.username}`;
}

export function formatSearchPage(result: SearchResult, idsOnly: boolean): string {
  const from = (result.page - 1) * result.pageSize + 1;
  const to = Math.min(result.page * result.pageSize, result.total);

  const header =
    result.total > result.pageSize
      ? `**Page ${result.page}** (${from}-${to}) (total ${result.total})`
      : `Found ${result.total} matching member${result.total === 1 ? "" : "s"}`;

  if (result.members.length === 0) {
    return header;
  }

  const list = idsOnly
    ? result.members.map((m) => m.id).join(" ")
    : result.members.map(formatMemberLine).join("\n");

  return `${header}\n${codeBlock(list, "js")}`;
}

export function formatBanSearchPage(
  bans: GuildBan[],
  page: number,
  _totalPages: number,
  total: number,
  from: number,
  to: number,
): string {
  const header =
    total > bans.length
      ? `**Page ${page}** (${from}-${to}) (total ${total})`
      : `Found ${total} matching member${total === 1 ? "" : "s"}`;

  if (bans.length === 0) {
    return header;
  }

  const list = bans.map((b) => formatUserLine(b.user)).join("\n");

  return `${header}\n${codeBlock(list, "js")}`;
}
