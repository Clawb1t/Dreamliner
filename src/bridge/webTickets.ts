import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { zTicketsConfig, type TicketsConfig } from "../config/schemas/tickets.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import {
  getTicket,
  getTicketStats,
  queryTickets,
  renameTicket,
  type TicketQueryFilters,
  type TicketRecord,
} from "../plugins/tickets/functions/tickets.js";
import { addToBlacklist, listBlacklist, removeFromBlacklist } from "../plugins/tickets/functions/blacklist.js";
import {
  performAddMember,
  performClaim,
  performClose,
  performRemoveMember,
  performUnclaim,
} from "../plugins/tickets/functions/actions.js";
import { getLatestTranscriptForTicket } from "../plugins/tickets/functions/transcripts.js";
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

async function toWebTicket(
  guild: Guild,
  ticket: TicketRecord,
  includeTranscript: boolean,
  pluginConfig: TicketsConfig,
): Promise<WebTicket> {
  const [opener, claimedBy, closedBy, transcript] = await Promise.all([
    resolvePerson(guild, ticket.openerId),
    resolvePerson(guild, ticket.claimedBy),
    resolvePerson(guild, ticket.closedBy),
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

export async function getGuildTicketStats(guild: Guild) {
  const stats = await getTicketStats(guild.id);
  const topClaimers = await Promise.all(
    stats.topClaimers.map(async (entry) => ({
      staff: (await resolvePerson(guild, entry.staffId)) ?? { id: entry.staffId, name: entry.staffId, username: null, avatar: null },
      count: entry.count,
    })),
  );
  return { ...stats, topClaimers };
}

export type TicketAction = "close" | "claim" | "unclaim" | "reopen" | "add" | "remove";

export async function performTicketAction(
  guild: Guild,
  ticketId: number,
  action: TicketAction,
  actorId: string,
  body: { reason?: string; userId?: string },
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
  } else if (action === "close") {
    if (ticket.status === "closed") return { error: "Ticket is already closed" };
    await performClose(guild.client, guild, guildConfig, pluginConfig, category, ticket, actorId, body.reason ?? null);
  } else if (action === "reopen") {
    const { reopenTicket } = await import("../plugins/tickets/functions/tickets.js");
    await reopenTicket(guild.id, ticketId);
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
