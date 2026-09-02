import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { zSuggestionsConfig, type SuggestionDisplayStatus } from "../config/schemas/suggestions.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import {
  getSuggestionById,
  getSuggestionByNumber,
  getVoteTotals,
  listSuggestions,
  suggestionStats,
  type Suggestion,
} from "../plugins/suggestions/functions/store.js";
import {
  approveSuggestion,
  deleteSuggestion,
  denySuggestion,
  markSuggestion,
} from "../plugins/suggestions/functions/service.js";

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
  anonymous: boolean;
  status: string;
  displayStatus: string;
  denialReason: string | null;
  createdAt: string;
  updatedAt: string;
  implementedAt: string | null;
  author: WebPerson;
  staffActor: WebPerson | null;
  votes: { up: number; mid: number; down: number; net: number };
  feedChannelId: string | null;
  feedMessageId: string | null;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebSuggestionsQuery = {
  q: string;
  status: string | null;
  displayStatus: string | null;
  authorId: string | null;
  limit: number;
  offset: number;
};

export function parseWebSuggestionsQuery(url: URL): WebSuggestionsQuery {
  return {
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 120),
    status: url.searchParams.get("status")?.trim() || null,
    displayStatus: url.searchParams.get("mark")?.trim() || null,
    authorId: url.searchParams.get("author")?.trim() || null,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
  };
}

async function resolvePerson(guild: Guild, userId: string | null | undefined): Promise<WebPerson | null> {
  if (!userId) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
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

async function toWebSuggestion(guild: Guild, suggestion: Suggestion): Promise<WebSuggestion> {
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
    anonymous: suggestion.anonymous,
    status: suggestion.status,
    displayStatus: suggestion.displayStatus,
    denialReason: suggestion.denialReason,
    createdAt: toIso(suggestion.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(suggestion.updatedAt) ?? new Date(0).toISOString(),
    implementedAt: toIso(suggestion.implementedAt),
    author: author ?? { id: suggestion.authorId, name: suggestion.authorId, username: null, avatar: null },
    staffActor,
    votes,
    feedChannelId: suggestion.feedChannelId,
    feedMessageId: suggestion.feedMessageId,
    reviewChannelId: suggestion.reviewChannelId,
    reviewMessageId: suggestion.reviewMessageId,
  };
}

async function getSuggestionsConfig(guildId: string) {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zSuggestionsConfig.parse(
    getPluginSettings(guildConfig, "suggestions"),
  );
}

export async function listWebSuggestions(guild: Guild, query: WebSuggestionsQuery) {
  const result = await listSuggestions(guild.id, {
    status: query.status as "awaiting_review" | "approved" | "denied" | null,
    displayStatus: query.displayStatus,
    authorId: query.authorId,
    q: query.q || undefined,
    limit: query.limit,
    offset: query.offset,
  });
  const items = await Promise.all(result.suggestions.map((s) => toWebSuggestion(guild, s)));
  return {
    suggestions: items,
    total: result.total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getWebSuggestion(guild: Guild, idOrNumber: number, byNumber = false) {
  const suggestion = byNumber
    ? await getSuggestionByNumber(guild.id, idOrNumber)
    : await getSuggestionById(idOrNumber);
  if (!suggestion || suggestion.guildId !== guild.id) return null;
  return toWebSuggestion(guild, suggestion);
}

export async function getWebSuggestionStats(guild: Guild) {
  return suggestionStats(guild.id);
}

export async function webApproveSuggestion(guild: Guild, suggestionId: number, staffId: string) {
  const config = await getSuggestionsConfig(guild.id);
  return approveSuggestion({
    client: guild.client,
    guild,
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
) {
  const config = await getSuggestionsConfig(guild.id);
  return denySuggestion({
    client: guild.client,
    guild,
    config,
    suggestionId,
    staffId,
    reason,
    silent,
  });
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

export async function webDeleteSuggestion(guild: Guild, suggestionId: number, staffId: string) {
  const config = await getSuggestionsConfig(guild.id);
  return deleteSuggestion({
    client: guild.client,
    guild,
    config,
    suggestionId,
    staffId,
  });
}
