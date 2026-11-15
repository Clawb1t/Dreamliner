import type { Guild } from "discord.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { configManager } from "../config/manager.js";
import { SUGGESTION_DISPLAY_STATUSES, zSuggestionsConfig, type SuggestionDisplayStatus } from "../config/schemas/suggestions.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import { parseDuration } from "../plugins/infraction/functions/duration.js";
import {
  authorSummary,
  blockUser,
  countCommentsFor,
  countFollowers,
  deleteComment,
  getBlock,
  getSuggestionById,
  getSuggestionByNumber,
  getVoteTotals,
  listBlocks,
  listComments,
  listSuggestions,
  listVoters,
  suggestionOverview,
  suggestionStats,
  unblockUser,
  type Suggestion,
  type SuggestionComment,
} from "../plugins/suggestions/functions/store.js";
import {
  addSuggestionComment,
  approveSuggestion,
  deleteSuggestion,
  denySuggestion,
  markSuggestion,
  refreshSuggestionPosts,
} from "../plugins/suggestions/functions/service.js";
import { resolveTextChannel } from "../plugins/suggestions/functions/embeds.js";
import { suggestionImageUrl } from "../plugins/suggestions/functions/image.js";
import {
  duplicateReason,
  isSuggestionSort,
  isSuggestionState,
  suggestionState,
  type SuggestionSort,
  type SuggestionState,
} from "../plugins/suggestions/functions/states.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebSuggestion = {
  id: number;
  suggestionNumber: number;
  content: string;
  attachmentUrl: string | null;
  /** True when the suggestion has an image (uploaded or linked). */
  hasImage: boolean;
  /** A viewable link to the image: only filled on the single-suggestion endpoint. */
  imageUrl: string | null;
  anonymous: boolean;
  status: string;
  displayStatus: string;
  /** status + displayStatus folded into one value (see states.ts). */
  state: SuggestionState;
  denialReason: string | null;
  createdAt: string;
  updatedAt: string;
  implementedAt: string | null;
  author: WebPerson;
  staffActor: WebPerson | null;
  votes: { up: number; mid: number; down: number; net: number };
  commentCount: number;
  feedChannelId: string | null;
  feedMessageId: string | null;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  deniedChannelId: string | null;
  deniedMessageId: string | null;
  archiveChannelId: string | null;
  archiveMessageId: string | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebSuggestionsQuery = {
  q: string;
  status: string | null;
  displayStatus: string | null;
  state: SuggestionState | null;
  sort: SuggestionSort;
  authorId: string | null;
  limit: number;
  offset: number;
};

export function parseWebSuggestionsQuery(url: URL): WebSuggestionsQuery {
  const state = url.searchParams.get("state")?.trim();
  const sort = url.searchParams.get("sort")?.trim();
  const author = url.searchParams.get("author")?.trim();
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    status: url.searchParams.get("status")?.trim() || null,
    displayStatus: url.searchParams.get("mark")?.trim() || null,
    state: isSuggestionState(state) ? state : null,
    sort: isSuggestionSort(sort) ? sort : "newest",
    authorId: author && /^\d{15,22}$/.test(author) ? author : null,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
  };
}

async function resolvePerson(guild: Guild, userId: string | null | undefined): Promise<WebPerson | null> {
  if (!userId) return null;
  const member = await fetchMemberCached(guild, userId);
  const user = member?.user ?? (await fetchUserCached(guild.client, userId));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function toWebSuggestion(
  guild: Guild,
  suggestion: Suggestion,
  commentCount: number,
  imageUrl: string | null = null,
): Promise<WebSuggestion> {
  const [author, staffActor, votes] = await Promise.all([
    resolvePerson(guild, suggestion.authorId),
    resolvePerson(guild, suggestion.staffActorId),
    getVoteTotals(suggestion.id),
  ]);

  return {
    id: suggestion.id,
    suggestionNumber: suggestion.suggestionNumber,
    content: suggestion.content,
    attachmentUrl: suggestion.attachmentUrl,
    hasImage: Boolean(suggestion.attachmentUrl),
    imageUrl,
    anonymous: suggestion.anonymous,
    status: suggestion.status,
    displayStatus: suggestion.displayStatus,
    state: suggestionState(suggestion.status, suggestion.displayStatus),
    denialReason: suggestion.denialReason,
    createdAt: toIso(suggestion.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(suggestion.updatedAt) ?? new Date(0).toISOString(),
    implementedAt: toIso(suggestion.implementedAt),
    author: author ?? { id: suggestion.authorId, name: suggestion.authorId, username: null, avatar: null },
    staffActor,
    votes,
    commentCount,
    feedChannelId: suggestion.feedChannelId,
    feedMessageId: suggestion.feedMessageId,
    reviewChannelId: suggestion.reviewChannelId,
    reviewMessageId: suggestion.reviewMessageId,
    deniedChannelId: suggestion.deniedChannelId,
    deniedMessageId: suggestion.deniedMessageId,
    archiveChannelId: suggestion.archiveChannelId,
    archiveMessageId: suggestion.archiveMessageId,
  };
}

async function getSuggestionsConfig(guildId: string) {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zSuggestionsConfig.parse(getPluginSettings(guildConfig, "suggestions"));
}

export async function listWebSuggestions(guild: Guild, query: WebSuggestionsQuery) {
  const result = await listSuggestions(guild.id, {
    status: query.status as "awaiting_review" | "approved" | "denied" | null,
    displayStatus: query.displayStatus,
    state: query.state,
    sort: query.sort,
    authorId: query.authorId,
    q: query.q || undefined,
    limit: query.limit,
    offset: query.offset,
  });
  const comments = await countCommentsFor(result.suggestions.map((s) => s.id));
  const items = await Promise.all(result.suggestions.map((s) => toWebSuggestion(guild, s, comments.get(s.id) ?? 0)));
  return {
    suggestions: items,
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
  };
}

/** The suggestion, only when it belongs to this server (ids are global, so every lookup by id checks). */
async function ownSuggestion(guild: Guild, suggestionId: number) {
  const suggestion = await getSuggestionById(suggestionId);
  return suggestion && suggestion.guildId === guild.id ? suggestion : null;
}

export async function getWebSuggestion(guild: Guild, idOrNumber: number, byNumber = false) {
  const suggestion = byNumber ? await getSuggestionByNumber(guild.id, idOrNumber) : await ownSuggestion(guild, idOrNumber);
  if (!suggestion || suggestion.guildId !== guild.id) return null;
  const [comments, imageUrl] = await Promise.all([
    countCommentsFor([suggestion.id]),
    suggestionImageUrl(guild.client, suggestion).catch(() => null),
  ]);
  return toWebSuggestion(guild, suggestion, comments.get(suggestion.id) ?? 0, imageUrl);
}

export type WebSuggestionVoter = { person: WebPerson; value: "up" | "mid" | "down"; votedAt: string };
export type WebThreadMessage = { id: string; author: WebPerson; content: string; createdAt: string; bot: boolean };
export type WebSuggestionThread = {
  id: string;
  name: string;
  archived: boolean;
  locked: boolean;
  messageCount: number | null;
  messages: WebThreadMessage[];
  error: string | null;
};

const VOTERS_SHOWN = 60;
const THREAD_MESSAGES_SHOWN = 25;

/** The discussion thread started on the feed post (a thread started from a message has its id). */
async function loadThread(guild: Guild, suggestion: Suggestion): Promise<WebSuggestionThread | null> {
  if (!suggestion.feedChannelId || !suggestion.feedMessageId) return null;
  const channel = await resolveTextChannel(guild.client, guild.id, suggestion.feedChannelId);
  if (!channel || !("threads" in channel)) return null;
  const thread = await channel.threads.fetch(suggestion.feedMessageId).catch(() => null);
  if (!thread || thread.parentId !== channel.id) return null;
  const base = {
    id: thread.id,
    name: thread.name,
    archived: Boolean(thread.archived),
    locked: Boolean(thread.locked),
    messageCount: thread.messageCount ?? null,
  };
  try {
    const fetched = await thread.messages.fetch({ limit: THREAD_MESSAGES_SHOWN });
    const messages = [...fetched.values()]
      .filter((m) => !m.system && m.content.trim())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({
        id: m.id,
        author: {
          id: m.author.id,
          name: m.member?.displayName ?? m.author.displayName ?? m.author.username,
          username: m.author.username,
          avatar: m.author.displayAvatarURL({ size: 64 }),
        },
        content: m.content.slice(0, 2000),
        createdAt: new Date(m.createdTimestamp).toISOString(),
        bot: m.author.bot,
      }));
    return { ...base, messages, error: null };
  } catch {
    return { ...base, messages: [], error: "Dreamliner can't read this thread (it needs Read Message History)." };
  }
}

/** Everything the dashboard's suggestion page shows: the suggestion, its comments, who voted, the
 *  discussion thread, and the author's record on this server. */
export async function getWebSuggestionDetail(guild: Guild, suggestionId: number) {
  const suggestion = await ownSuggestion(guild, suggestionId);
  if (!suggestion) return null;
  const [web, comments, voterRows, followers, summary, block, thread] = await Promise.all([
    getWebSuggestion(guild, suggestion.id),
    listComments(suggestion.id, 100),
    listVoters(suggestion.id, 0, VOTERS_SHOWN),
    countFollowers(suggestion.id),
    authorSummary(guild.id, suggestion.authorId),
    getBlock(guild.id, suggestion.authorId),
    loadThread(guild, suggestion).catch(() => null),
  ]);
  if (!web) return null;
  const [webComments, voters] = await Promise.all([
    Promise.all(comments.map((c) => toWebComment(guild, c))),
    Promise.all(
      voterRows.map(async (v) => ({
        person: (await resolvePerson(guild, v.userId)) ?? { id: v.userId, name: v.userId, username: null, avatar: null },
        value: v.value,
        votedAt: toIso(v.votedAt) ?? new Date(0).toISOString(),
      })),
    ),
  ]);
  return {
    suggestion: web,
    comments: webComments,
    voters,
    votersTotal: web.votes.up + web.votes.mid + web.votes.down,
    followers,
    authorSummary: summary,
    authorBlock: block
      ? { reason: block.reason, expiresAt: toIso(block.expiresAt), createdBy: block.createdBy, createdAt: toIso(block.createdAt) }
      : null,
    thread,
  };
}

/** The old per-status counts (kept for older site builds) plus the full stats row. */
export async function getWebSuggestionStats(guild: Guild) {
  const [legacy, overview] = await Promise.all([suggestionStats(guild.id), suggestionOverview(guild.id)]);
  return { ...legacy, ...overview };
}

export async function webApproveSuggestion(guild: Guild, suggestionId: number, staffId: string) {
  const config = await getSuggestionsConfig(guild.id);
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  return approveSuggestion({
    client: guild.client,
    guild,
    guildConfig,
    config,
    suggestionId,
    staffId,
  });
}

export async function webDenySuggestion(
  guild: Guild,
  suggestionId: number,
  staffId: string,
  reason?: string,
  silent?: boolean,
  duplicateOf?: number | null,
) {
  const config = await getSuggestionsConfig(guild.id);
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  let finalReason = reason?.trim().slice(0, 1000) || undefined;
  if (duplicateOf) {
    const original = await getSuggestionByNumber(guild.id, duplicateOf);
    if (!original) return { suggestion: null, error: `Suggestion #${duplicateOf} doesn't exist.` };
    if (original.id === suggestionId) return { suggestion: null, error: "A suggestion can't be a duplicate of itself." };
    finalReason = duplicateReason(duplicateOf, finalReason);
  }
  return denySuggestion({
    client: guild.client,
    guild,
    guildConfig,
    config,
    suggestionId,
    staffId,
    reason: finalReason,
    silent,
  });
}

export function isDisplayStatus(value: unknown): value is SuggestionDisplayStatus {
  return typeof value === "string" && (SUGGESTION_DISPLAY_STATUSES as readonly string[]).includes(value);
}

export async function webMarkSuggestion(
  guild: Guild,
  suggestionId: number,
  staffId: string,
  displayStatus: SuggestionDisplayStatus,
) {
  const config = await getSuggestionsConfig(guild.id);
  return markSuggestion({
    client: guild.client,
    guild,
    config,
    suggestionId,
    staffId,
    displayStatus,
  });
}

export async function webDeleteSuggestion(guild: Guild, suggestionId: number, staffId: string, silent = false) {
  const config = await getSuggestionsConfig(guild.id);
  return deleteSuggestion({
    client: guild.client,
    guild,
    config,
    suggestionId,
    staffId,
    silent,
  });
}

export type WebBulkAction = "approve" | "deny" | "mark" | "delete";

/** Runs one action over several suggestions, one at a time, through the same service functions as
 *  the single actions (and the /suggestion mass commands). */
export async function webBulkSuggestions(
  guild: Guild,
  staffId: string,
  input: { ids: number[]; action: WebBulkAction; reason?: string; status?: SuggestionDisplayStatus; silent?: boolean },
): Promise<{ ok: number[]; failed: Array<{ id: number; error: string }> }> {
  const ok: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  for (const id of input.ids) {
    let result: { suggestion: unknown; error?: string };
    try {
      if (input.action === "approve") result = await webApproveSuggestion(guild, id, staffId);
      else if (input.action === "deny") result = await webDenySuggestion(guild, id, staffId, input.reason, input.silent);
      else if (input.action === "mark") result = await webMarkSuggestion(guild, id, staffId, input.status ?? "considered");
      else result = await webDeleteSuggestion(guild, id, staffId, input.silent);
    } catch (error) {
      result = { suggestion: null, error: error instanceof Error ? error.message : "Action failed" };
    }
    if (result.error || !result.suggestion) failed.push({ id, error: result.error ?? "Action failed" });
    else ok.push(id);
  }
  return { ok, failed };
}

export type WebSuggestionComment = {
  id: number;
  content: string;
  anonymous: boolean;
  createdAt: string;
  author: WebPerson;
};

async function toWebComment(guild: Guild, comment: SuggestionComment): Promise<WebSuggestionComment> {
  // Staff see who wrote an anonymous comment (same as anonymous suggestions); the flag stays so the page can say so.
  const author = await resolvePerson(guild, comment.authorId);
  return {
    id: comment.id,
    content: comment.content,
    anonymous: comment.anonymous,
    createdAt: toIso(comment.createdAt) ?? new Date(0).toISOString(),
    author: author ?? { id: comment.authorId, name: comment.authorId, username: null, avatar: null },
  };
}

export async function listWebSuggestionComments(guild: Guild, suggestionId: number) {
  if (!(await ownSuggestion(guild, suggestionId))) return null;
  const comments = await listComments(suggestionId, 100);
  return Promise.all(comments.map((c) => toWebComment(guild, c)));
}

/** Dashboard-authored comments are never anonymous. Staff commenting through the dashboard are
 *  already acting in an identified, official capacity, unlike a member using `/suggestion comment`. */
export async function addWebSuggestionComment(
  guild: Guild,
  suggestionId: number,
  staffId: string,
  content: string,
): Promise<{ comment: WebSuggestionComment } | { error: string }> {
  const config = await getSuggestionsConfig(guild.id);
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const staff = await resolvePerson(guild, staffId);
  const result = await addSuggestionComment({
    client: guild.client,
    guild,
    guildConfig,
    config,
    suggestionId,
    authorId: staffId,
    authorName: staff?.username ?? staffId,
    authorAvatarUrl: staff?.avatar ?? undefined,
    content: content.slice(0, 1000),
    anonymous: false,
  });
  if ("error" in result) return result;
  return { comment: await toWebComment(guild, result.comment) };
}

/** Deletes a comment only when it's on this suggestion and the suggestion is in this server, then
 *  re-renders the suggestion's posts so the comment drops off them too. */
export async function deleteWebSuggestionComment(guild: Guild, suggestionId: number, commentId: number): Promise<{ ok: boolean }> {
  if (!(await ownSuggestion(guild, suggestionId))) return { ok: false };
  const ok = await deleteComment(commentId, suggestionId);
  if (ok) {
    const config = await getSuggestionsConfig(guild.id);
    await refreshSuggestionPosts({ client: guild.client, guild, config, suggestionId }).catch(() => null);
  }
  return { ok };
}

// ── Blocked members ───────────────────────────────────────────────────────────

export type WebSuggestionBlock = {
  person: WebPerson;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: WebPerson | null;
};

export async function listWebSuggestionBlocks(guild: Guild): Promise<WebSuggestionBlock[]> {
  const now = Date.now();
  const rows = (await listBlocks(guild.id)).filter((b) => !b.expiresAt || b.expiresAt.getTime() > now);
  return Promise.all(
    rows.map(async (b) => ({
      person: (await resolvePerson(guild, b.userId)) ?? { id: b.userId, name: b.userId, username: null, avatar: null },
      reason: b.reason,
      expiresAt: toIso(b.expiresAt),
      createdAt: toIso(b.createdAt),
      createdBy: await resolvePerson(guild, b.createdBy),
    })),
  );
}

/** Same as /suggestion block: an optional reason and an optional duration like `7d`. */
export async function webBlockSuggester(
  guild: Guild,
  staffId: string,
  input: { userId: string; reason?: string | null; duration?: string | null },
): Promise<{ ok: true; expiresAt: string | null } | { error: string }> {
  if (!/^\d{15,22}$/.test(input.userId)) return { error: "Pick a member to block." };
  if (input.userId === staffId) return { error: "You can't block yourself." };
  let expiresAt: Date | null = null;
  const duration = input.duration?.trim();
  if (duration) {
    const ms = parseDuration(duration);
    if (ms == null) return { error: "Use a duration like 7d or 24h, or leave it empty for no end date." };
    expiresAt = new Date(Date.now() + ms);
  }
  await blockUser({
    guildId: guild.id,
    userId: input.userId,
    reason: input.reason?.trim().slice(0, 500) || null,
    expiresAt,
    createdBy: staffId,
  });
  return { ok: true, expiresAt: toIso(expiresAt) };
}

export async function webUnblockSuggester(guild: Guild, userId: string): Promise<boolean> {
  return unblockUser(guild.id, userId);
}
