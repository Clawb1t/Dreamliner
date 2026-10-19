import type { Guild } from "discord.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { configManager } from "../config/manager.js";
import { zTicketsConfig, type TicketsConfig } from "../config/schemas/tickets.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import {
  getTicket,
  getTicketHandlerStats,
  getTicketStats,
  queryTickets,
  renameTicket,
  type TicketHandlerStatsSummary,
  type TicketQueryFilters,
  type TicketRecord,
} from "../plugins/tickets/functions/tickets.js";
import { TICKET_STATUSES, TICKET_STATUS_LABELS, type TicketStatus } from "../config/schemas/tickets.js";
import { addToBlacklist, listBlacklist, removeFromBlacklist } from "../plugins/tickets/functions/blacklist.js";
import {
  performAddMember,
  performAssign,
  performClaim,
  performClose,
  performRemoveMember,
  performSetStatus,
  performUnassign,
  performUnclaim,
} from "../plugins/tickets/functions/actions.js";
import {
  getLatestTranscriptForTicket,
  getTranscriptRecord,
  isTranscriptParticipant,
  type TranscriptMessage,
} from "../plugins/tickets/functions/transcripts.js";
import { hasPermission } from "../core/permissionRoles.js";
import { postPanel } from "../plugins/tickets/functions/panels.js";
import { deleteTicket as deleteTicketRow } from "../plugins/tickets/functions/tickets.js";
import { deleteContainer } from "../plugins/tickets/functions/channels.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebTicket = {
  id: number;
  number: number;
  panelId: string;
  panelName: string;
  categoryId: string;
  categoryLabel: string;
  channelId: string;
  threadId: string | null;
  mode: string;
  status: string;
  /** Work-in-progress status independent of open/closed (e.g. "awaiting_response"). Null = no special status. */
  subStatus: string | null;
  subStatusLabel: string | null;
  priority: string;
  opener: WebPerson;
  claimedBy: WebPerson | null;
  members: string[];
  formResponses: { questionId: string; label: string; answer: string }[];
  createdAt: string;
  closedAt: string | null;
  closedBy: WebPerson | null;
  closeReason: string | null;
  lastActivityAt: string;
  ratingScore: number | null;
  ratingComment: string | null;
  /** Last time a support-role member replied. Null if staff never has — the SLA clock runs from createdAt instead. */
  lastStaffReplyAt: string | null;
  /** First time any staff member ever replied. Powers the response-time stat. */
  firstStaffReplyAt: string | null;
  firstResponder: WebPerson | null;
  /** Index of the highest escalation step already fired since the last staff reply. -1 = none yet. */
  escalationStep: number;
  transcript?: { id: string; messages: unknown[] } | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebTicketsQuery = TicketQueryFilters;

export function parseWebTicketsQuery(url: URL): WebTicketsQuery {
  const status = url.searchParams.get("status")?.trim();
  return {
    status: status === "open" || status === "closed" ? status : undefined,
    categoryId: url.searchParams.get("categoryId")?.trim() || undefined,
    panelId: url.searchParams.get("panelId")?.trim() || undefined,
    openerId: url.searchParams.get("openerId")?.trim() || undefined,
    claimedBy: url.searchParams.get("claimedBy")?.trim() || undefined,
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

async function toWebTicket(
  guild: Guild,
  ticket: TicketRecord,
  includeTranscript: boolean,
  pluginConfig: TicketsConfig,
): Promise<WebTicket> {
  const [opener, claimedBy, closedBy, firstResponder, transcript] = await Promise.all([
    resolvePerson(guild, ticket.openerId),
    resolvePerson(guild, ticket.claimedBy),
    resolvePerson(guild, ticket.closedBy),
    resolvePerson(guild, ticket.firstResponderId),
    includeTranscript && ticket.status === "closed" ? getLatestTranscriptForTicket(guild.id, ticket.id) : Promise.resolve(null),
  ]);

  const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
  const category = panel?.categories.find((c) => c.id === ticket.categoryId);

  return {
    id: ticket.id,
    number: ticket.number,
    panelId: ticket.panelId,
    panelName: panel?.name?.trim() || "Unknown panel",
    categoryId: ticket.categoryId,
    categoryLabel: category?.label?.trim() || "Unknown category",
    channelId: ticket.channelId,
    threadId: ticket.threadId,
    mode: ticket.mode,
    status: ticket.status,
    subStatus: ticket.subStatus,
    subStatusLabel: ticket.subStatus ? TICKET_STATUS_LABELS[ticket.subStatus] : null,
    priority: ticket.priority,
    opener: opener ?? { id: ticket.openerId, name: ticket.openerId, username: null, avatar: null },
    claimedBy,
    members: ticket.memberIds,
    formResponses: ticket.formResponses,
    createdAt: toIso(ticket.createdAt) ?? new Date(0).toISOString(),
    closedAt: toIso(ticket.closedAt),
    closedBy,
    closeReason: ticket.closeReason,
    lastActivityAt: toIso(ticket.lastActivityAt) ?? new Date(0).toISOString(),
    ratingScore: ticket.ratingScore,
    ratingComment: ticket.ratingComment,
    lastStaffReplyAt: toIso(ticket.lastStaffReplyAt),
    firstStaffReplyAt: toIso(ticket.firstStaffReplyAt),
    firstResponder,
    escalationStep: ticket.escalationStep,
    ...(includeTranscript ? { transcript } : {}),
  };
}

async function getTicketsConfig(guildId: string): Promise<TicketsConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
}

export async function listGuildTickets(guild: Guild, query: WebTicketsQuery) {
  const result = await queryTickets(guild.id, query);
  const pluginConfig = await getTicketsConfig(guild.id);
  const items = await Promise.all(result.tickets.map((t) => toWebTicket(guild, t, false, pluginConfig)));
  return {
    tickets: items,
    total: result.total,
    limit: query.limit ?? DEFAULT_LIMIT,
    offset: query.offset ?? 0,
  };
}

export async function getGuildTicket(guild: Guild, ticketId: number): Promise<WebTicket | null> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return null;
  const pluginConfig = await getTicketsConfig(guild.id);
  return toWebTicket(guild, ticket, true, pluginConfig);
}

export type WebTicketHandlerStat = {
  staff: WebPerson;
  activeAssigned: number;
  ticketsClosed: number;
  avgResolutionMs: number | null;
  ticketsResponded: number;
  avgFirstResponseMs: number | null;
};

async function resolveHandlerStats(guild: Guild, summary: TicketHandlerStatsSummary): Promise<WebTicketHandlerStat[]> {
  return Promise.all(
    summary.handlers.map(async (h) => ({
      staff: (await resolvePerson(guild, h.staffId)) ?? { id: h.staffId, name: h.staffId, username: null, avatar: null },
      activeAssigned: h.activeAssigned,
      ticketsClosed: h.ticketsClosed,
      avgResolutionMs: h.avgResolutionMs,
      ticketsResponded: h.ticketsResponded,
      avgFirstResponseMs: h.avgFirstResponseMs,
    })),
  );
}

/** Mirrors what `/ticket stats` shows in Discord, so the dashboard's ticket list can surface
 * the same time-tracking numbers (resolution/response time, per-handler breakdown) without
 * anyone needing to run the command. */
export async function getGuildTicketStats(guild: Guild, opts: { sinceDays?: number } = {}) {
  const stats = await getTicketStats(guild.id);
  const topClaimers = await Promise.all(
    stats.topClaimers.map(async (entry) => ({
      staff: (await resolvePerson(guild, entry.staffId)) ?? { id: entry.staffId, name: entry.staffId, username: null, avatar: null },
      count: entry.count,
    })),
  );
  const handlerSummary = await getTicketHandlerStats(guild.id, {
    sinceMs: opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : undefined,
  });
  const handlers = await resolveHandlerStats(guild, handlerSummary);
  return { ...stats, topClaimers, overall: handlerSummary.overall, handlers };
}

export const TICKET_STATUS_OPTIONS = TICKET_STATUSES.map((value) => ({ value, label: TICKET_STATUS_LABELS[value] }));

export type TicketAction = "close" | "claim" | "unclaim" | "assign" | "unassign" | "status" | "reopen" | "add" | "remove";

export async function performTicketAction(
  guild: Guild,
  ticketId: number,
  action: TicketAction,
  actorId: string,
  body: { reason?: string; userId?: string; status?: string },
): Promise<{ ticket: WebTicket } | { error: string }> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return { error: "Ticket not found" };

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const pluginConfig = await getTicketsConfig(guild.id);
  const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
  const category = panel?.categories.find((c) => c.id === ticket.categoryId);

  if (action === "claim") {
    await performClaim(guild.client, guildConfig, pluginConfig, ticket, actorId);
  } else if (action === "unclaim") {
    await performUnclaim(ticket);
  } else if (action === "assign") {
    if (!body.userId) return { error: "userId is required" };
    await performAssign(guild.client, guildConfig, pluginConfig, ticket, body.userId, actorId);
  } else if (action === "unassign") {
    await performUnassign(guild.client, guildConfig, pluginConfig, ticket, actorId);
  } else if (action === "status") {
    if (!body.status || !(TICKET_STATUSES as readonly string[]).includes(body.status)) {
      return { error: `status must be one of: ${TICKET_STATUSES.join(", ")}` };
    }
    await performSetStatus(guild.client, guildConfig, pluginConfig, ticket, body.status as TicketStatus, actorId);
  } else if (action === "close") {
    if (ticket.status === "closed") return { error: "Ticket is already closed" };
    await performClose(guild.client, guild, guildConfig, pluginConfig, category, ticket, actorId, body.reason ?? null);
  } else if (action === "reopen") {
    const { reopenTicket } = await import("../plugins/tickets/functions/tickets.js");
    const { restoreContainerAccess } = await import("../plugins/tickets/functions/channels.js");
    await reopenTicket(guild.id, ticketId);
    await restoreContainerAccess(guild, ticket);
  } else if (action === "add" || action === "remove") {
    if (!body.userId) return { error: "userId is required" };
    const updated =
      action === "add"
        ? await performAddMember(guild, ticket, body.userId)
        : await performRemoveMember(guild, ticket, body.userId);
    if (!updated) return { error: "Could not update ticket members" };
  }

  const refreshed = await getTicket(guild.id, ticketId);
  if (!refreshed) return { error: "Ticket not found after update" };
  return { ticket: await toWebTicket(guild, refreshed, true, pluginConfig) };
}

export async function deleteGuildTicket(guild: Guild, ticketId: number): Promise<{ deleted: boolean } | { error: string }> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return { error: "Ticket not found" };
  await deleteContainer(guild, ticket);
  await deleteTicketRow(guild.id, ticketId);
  return { deleted: true };
}

export async function webRenameTicket(guild: Guild, ticketId: number, name: string): Promise<{ ok: boolean } | { error: string }> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return { error: "Ticket not found" };
  const ok = await renameTicket(guild.client, ticket, name);
  return ok ? { ok: true } : { error: "Could not rename the ticket's channel" };
}

export async function publishTicketPanel(guild: Guild, panelId: string, actorId: string): Promise<{ messageId: string } | { error: string }> {
  const pluginConfig = await getTicketsConfig(guild.id);
  const panel = pluginConfig.panels.find((p) => p.id === panelId);
  if (!panel) return { error: "Panel not found" };

  const messageId = await postPanel(guild.client, guild.id, panel);
  if (!messageId) return { error: "Could not post the panel. Check its channel configuration." };

  const patchedPanels = pluginConfig.panels.map((p) => (p.id === panelId ? { ...p, message_id: messageId } : p));
  await configManager.patchPluginConfig(guild.id, "tickets", { panels: patchedPanels }, actorId);

  return { messageId };
}

export async function listGuildTicketBlacklist(guild: Guild) {
  return listBlacklist(guild.id);
}

export async function addGuildTicketBlacklist(guild: Guild, targetId: string, targetType: "user" | "role", reason?: string) {
  await addToBlacklist(guild.id, targetId, targetType, reason);
  return listBlacklist(guild.id);
}

export async function removeGuildTicketBlacklist(guild: Guild, targetId: string) {
  await removeFromBlacklist(guild.id, targetId);
  return listBlacklist(guild.id);
}

// ---------------------------------------------------------------------------------------------
// Web transcript page (/server/:guildId/tickets/transcript/:transcriptId)
// ---------------------------------------------------------------------------------------------

export type WebTranscriptMentions = {
  users: Record<string, string>;
  roles: Record<string, { name: string; color: number }>;
  channels: Record<string, string>;
};

export type WebTranscriptPayload = {
  ok: true;
  guild: { id: string; name: string; icon: string | null };
  ticket: {
    id: number;
    number: number;
    status: string;
    categoryLabel: string | null;
    panelName: string | null;
    opener: WebPerson;
    claimedBy: WebPerson | null;
    closedBy: WebPerson | null;
    closeReason: string | null;
    createdAt: string | null;
    closedAt: string | null;
  } | null;
  transcript: {
    id: string;
    createdAt: string;
    channelName: string | null;
    messageCount: number;
    messages: TranscriptMessage[];
  };
  mentions: WebTranscriptMentions;
};

export type WebTranscriptResult = WebTranscriptPayload | { ok: false; code: "forbidden" | "not_found" };

const MAX_MENTIONS_PER_KIND = 300;

/** Every <@user>, <@&role> and <#channel> referenced anywhere a reader will see text. */
export function collectTranscriptMentionIds(messages: TranscriptMessage[]): { users: Set<string>; roles: Set<string>; channels: Set<string> } {
  const users = new Set<string>();
  const roles = new Set<string>();
  const channels = new Set<string>();
  const scan = (text: string | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(/<@(!|&)?(\d{5,20})>/g)) {
      if (m[1] === "&") {
        if (roles.size < MAX_MENTIONS_PER_KIND) roles.add(m[2]!);
      } else if (users.size < MAX_MENTIONS_PER_KIND) users.add(m[2]!);
    }
    for (const m of text.matchAll(/<#(\d{5,20})>/g)) if (channels.size < MAX_MENTIONS_PER_KIND) channels.add(m[1]!);
  };
  for (const message of messages) {
    scan(message.content);
    for (const embed of message.embeds ?? []) {
      scan(embed.title);
      scan(embed.description);
      scan(embed.footer?.text);
      for (const field of embed.fields ?? []) {
        scan(field.name);
        scan(field.value);
      }
    }
    for (const block of message.components ?? []) {
      for (const item of block.items) if (item.type === "text") scan(item.content);
    }
  }
  return { users, roles, channels };
}

/**
 * Who may read a transcript: anyone who was part of the ticket, server managers (`canManage`,
 * checked by the bridge), and members with the tickets `can_view_all` permission. Never fetches
 * per-message author data from Discord: stored snapshots first, then whatever is already cached.
 */
export async function getWebTranscript(
  guild: Guild,
  transcriptId: string,
  viewerId: string,
  canManage: () => Promise<boolean>,
): Promise<WebTranscriptResult> {
  const record = await getTranscriptRecord(guild.id, transcriptId);
  const ticket = record ? await getTicket(guild.id, record.ticketId) : null;

  const isStaff = async (): Promise<boolean> => {
    if (await canManage()) return true;
    const member = await fetchMemberCached(guild, viewerId);
    if (!member) return false;
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    return hasPermission(guild.id, "tickets", "can_view_all", member, guildConfig);
  };

  const participant =
    record !== null &&
    isTranscriptParticipant(viewerId, ticket ?? { openerId: "", memberIds: [], claimedBy: null }, record.messages);
  const allowed = participant || (await isStaff());
  // Only someone who could see any transcript here learns that this one doesn't exist.
  if (!record) return { ok: false, code: allowed ? "not_found" : "forbidden" };
  if (!allowed) return { ok: false, code: "forbidden" };

  const messages = record.messages.map((message): TranscriptMessage => {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (message.authorName && message.authorAvatar !== undefined) return { ...message, attachments };
    // Older payloads: fill name/avatar from the cache only (no Discord round trips per message).
    const member = guild.members.cache.get(message.authorId);
    const user = member?.user ?? guild.client.users.cache.get(message.authorId);
    return {
      ...message,
      attachments,
      authorName: message.authorName ?? member?.displayName ?? user?.globalName ?? user?.username ?? message.authorTag,
      authorAvatar: message.authorAvatar ?? (member ?? user)?.displayAvatarURL({ size: 64 }) ?? null,
      authorBot: message.authorBot ?? user?.bot ?? false,
    };
  });

  const ids = collectTranscriptMentionIds(messages);
  const authorNames = new Map(messages.map((m) => [m.authorId, m.authorName ?? m.authorTag]));
  const mentions: WebTranscriptMentions = { users: {}, roles: {}, channels: {} };
  for (const id of ids.users) {
    const member = guild.members.cache.get(id);
    const user = member?.user ?? guild.client.users.cache.get(id);
    const name = authorNames.get(id) ?? member?.displayName ?? user?.globalName ?? user?.username;
    if (name) mentions.users[id] = name;
  }
  for (const id of ids.roles) {
    const role = guild.roles.cache.get(id);
    if (role) mentions.roles[id] = { name: role.name, color: role.color };
  }
  for (const id of ids.channels) {
    const channel = guild.channels.cache.get(id);
    if (channel) mentions.channels[id] = channel.name;
  }

  let ticketMeta: WebTranscriptPayload["ticket"] = null;
  if (ticket) {
    const pluginConfig = await getTicketsConfig(guild.id);
    const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    const [opener, claimedBy, closedBy] = await Promise.all([
      resolvePerson(guild, ticket.openerId),
      resolvePerson(guild, ticket.claimedBy),
      resolvePerson(guild, ticket.closedBy),
    ]);
    ticketMeta = {
      id: ticket.id,
      number: ticket.number,
      status: ticket.status,
      categoryLabel: category?.label?.trim() || null,
      panelName: panel?.name?.trim() || null,
      opener: opener ?? { id: ticket.openerId, name: ticket.openerId, username: null, avatar: null },
      claimedBy,
      closedBy,
      closeReason: ticket.closeReason,
      createdAt: toIso(ticket.createdAt),
      closedAt: toIso(ticket.closedAt),
    };
  }

  return {
    ok: true,
    guild: { id: guild.id, name: guild.name, icon: guild.icon },
    ticket: ticketMeta,
    transcript: {
      id: record.id,
      createdAt: toIso(record.createdAt) ?? new Date(0).toISOString(),
      channelName: record.channelName,
      messageCount: messages.length,
      messages,
    },
    mentions,
  };
}
