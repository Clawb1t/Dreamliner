import type { Guild } from "discord.js";
import { fetchMemberCached, fetchUserCached } from "./people.js";
import { configManager } from "../config/manager.js";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  zTicketsConfig,
  type TicketPriority,
  type TicketStatus,
  type TicketsConfig,
} from "../config/schemas/tickets.js";
import { getPluginSettings, hasPermission } from "../core/permissionRoles.js";
import { fetchGuildChannel } from "../core/guildChannel.js";
import { containerReply } from "../core/responses.js";
import {
  deleteTicket as deleteTicketRow,
  getTicket,
  getTicketHandlerStats,
  getTicketStats,
  queryTickets,
  renameTicket,
  setPriority,
  type TicketHandlerStatsSummary,
  type TicketQueryFilters,
  type TicketRecord,
} from "../plugins/tickets/functions/tickets.js";
import { addToBlacklist, listBlacklist, removeFromBlacklist } from "../plugins/tickets/functions/blacklist.js";
import {
  buildTicketClaimedEmbed,
  performAddMember,
  performAssign,
  performClaim,
  performClose,
  performRemoveMember,
  performReopen,
  performSetStatus,
  performUnassign,
  performUnclaim,
  performWebReply,
} from "../plugins/tickets/functions/actions.js";
import {
  getLatestTranscriptForTicket,
  getTranscriptRecord,
  isTranscriptParticipant,
  mapTranscriptMessage,
  type TranscriptMessage,
} from "../plugins/tickets/functions/transcripts.js";
import { buildMemberContextSummary, gatherMemberContext } from "../plugins/tickets/functions/memberContext.js";
import { postPanel } from "../plugins/tickets/functions/panels.js";
import { deleteContainer } from "../plugins/tickets/functions/channels.js";
import {
  parseTicketSort,
  parseTicketView,
  sortTickets,
  summarizeTickets,
  ticketMatchesView,
  ticketWaitInfo,
  type WebTicketBulkAction,
  type WebTicketSort,
  type WebTicketView,
} from "./webTicketsLogic.js";

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
  /** Open and waiting on a staff reply right now. */
  awaitingStaff: boolean;
  /** Since when it has been waiting on staff (null when it isn't). */
  waitingSince: string | null;
  /** Waiting on staff and an SLA escalation step already fired. */
  slaBreached: boolean;
  /** The saved transcript (closed tickets), without its messages. */
  transcript?: { id: string; messageCount: number } | null;
};

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type WebTicketsQuery = TicketQueryFilters & {
  /** Free-text search: ticket number ("12" or "#12"), category label, or channel/thread id or name. */
  q?: string;
  /** Status chip on the list; wins over `status` when both are given. */
  view?: WebTicketView;
  sort?: WebTicketSort;
};

const SNOWFLAKE = /^\d{15,22}$/;

export function parseWebTicketsQuery(url: URL): WebTicketsQuery {
  const status = url.searchParams.get("status")?.trim();
  const openerId = url.searchParams.get("openerId")?.trim();
  const claimedBy = url.searchParams.get("claimedBy")?.trim();
  return {
    status: status === "open" || status === "closed" ? status : undefined,
    view: parseTicketView(url.searchParams.get("view")?.trim()),
    sort: parseTicketSort(url.searchParams.get("sort")?.trim()),
    categoryId: url.searchParams.get("categoryId")?.trim() || undefined,
    panelId: url.searchParams.get("panelId")?.trim() || undefined,
    openerId: openerId && SNOWFLAKE.test(openerId) ? openerId : undefined,
    claimedBy: claimedBy && SNOWFLAKE.test(claimedBy) ? claimedBy : undefined,
    q: url.searchParams.get("q")?.trim().slice(0, 100) || undefined,
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

function personOrId(person: WebPerson | null, id: string): WebPerson {
  return person ?? { id, name: id, username: null, avatar: null };
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function labelsFor(pluginConfig: TicketsConfig, ticket: Pick<TicketRecord, "panelId" | "categoryId">) {
  const panel = pluginConfig.panels.find((p) => p.id === ticket.panelId);
  const category = panel?.categories.find((c) => c.id === ticket.categoryId);
  return {
    panel,
    category,
    panelName: panel?.name?.trim() || "Unknown panel",
    categoryLabel: category?.label?.trim() || "Unknown category",
  };
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

  const { panelName, categoryLabel } = labelsFor(pluginConfig, ticket);
  const wait = ticketWaitInfo(ticket);

  return {
    id: ticket.id,
    number: ticket.number,
    panelId: ticket.panelId,
    panelName,
    categoryId: ticket.categoryId,
    categoryLabel,
    channelId: ticket.channelId,
    threadId: ticket.threadId,
    mode: ticket.mode,
    status: ticket.status,
    subStatus: ticket.subStatus,
    subStatusLabel: ticket.subStatus ? TICKET_STATUS_LABELS[ticket.subStatus] : null,
    priority: ticket.priority,
    opener: personOrId(opener, ticket.openerId),
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
    awaitingStaff: wait.awaitingStaff,
    waitingSince: toIso(wait.waitingSince),
    slaBreached: wait.slaBreached,
    ...(includeTranscript ? { transcript: transcript ? { id: transcript.id, messageCount: transcript.messages.length } : null } : {}),
  };
}

async function getTicketsConfig(guildId: string): Promise<TicketsConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zTicketsConfig.parse(getPluginSettings(guildConfig, "tickets"));
}

function ticketMatchesSearch(guild: Guild, ticket: TicketRecord, pluginConfig: TicketsConfig, q: string): boolean {
  const needle = q.toLowerCase();
  const number = needle.replace(/^#/, "");
  if (/^\d+$/.test(number) && ticket.number === Number(number)) return true;
  if (ticket.openerId === q) return true;
  const channelIds = [ticket.channelId, ticket.threadId].filter((id): id is string => Boolean(id));
  if (channelIds.includes(q)) return true;
  if (channelIds.some((id) => guild.channels.cache.get(id)?.name.toLowerCase().includes(needle))) return true;
  const label = pluginConfig.panels
    .find((p) => p.id === ticket.panelId)
    ?.categories.find((c) => c.id === ticket.categoryId)?.label;
  return Boolean(label?.toLowerCase().includes(needle));
}

export async function listGuildTickets(guild: Guild, query: WebTicketsQuery) {
  const pluginConfig = await getTicketsConfig(guild.id);
  const view = query.view;
  // The bot's query filters by open/closed only; the claimed/unclaimed split, search and the
  // sorts run here on the (already filtered) set.
  const status = view === "closed" ? "closed" : view === "open" || view === "claimed" || view === "unclaimed" ? "open" : view === "all" ? undefined : query.status;
  const all = await queryTickets(guild.id, { ...query, status, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  let matched = all.tickets;
  if (view) matched = matched.filter((t) => ticketMatchesView(t, view));
  if (query.q) matched = matched.filter((t) => ticketMatchesSearch(guild, t, pluginConfig, query.q!));
  matched = sortTickets(matched, query.sort ?? "newest");
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const page = matched.slice(offset, offset + limit);
  const items = await Promise.all(page.map((t) => toWebTicket(guild, t, false, pluginConfig)));
  return {
    tickets: items,
    total: matched.length,
    limit,
    offset,
    // Category filter options, from this server's panels.
    categories: pluginConfig.panels.flatMap((p) =>
      p.categories.map((c) => ({ id: c.id, label: c.label.trim() || "Untitled category", panelId: p.id, panelName: p.name.trim() || "Panel" })),
    ),
  };
}

export type WebTicketMessage = TranscriptMessage;

export type WebTicketMemberContext = {
  cases: { active: number; total: number; overturned: number; notes: number; latest: { id: number; type: string; createdAt: string } | null };
  openAppeal: { id: number; status: string; caseId: number | null } | null;
  passport: { state: "verified" | "pending" | "unverified" | "off"; verifiedAt: string | null };
  previousTickets: { count: number; open: number; capped: boolean };
};

export type WebTicketDetail = WebTicket & {
  /** What to show as the conversation: the live channel for open tickets, the saved transcript for closed ones. */
  conversation: {
    source: "live" | "transcript" | "none";
    messages: WebTicketMessage[];
    /** Only the latest messages are shown (the channel has more). */
    truncated: boolean;
    error: string | null;
  };
  mentions: WebTranscriptMentions;
  memberContext: WebTicketMemberContext | null;
  otherTickets: Array<{ id: number; number: number; status: string; categoryLabel: string; createdAt: string; closedAt: string | null }>;
  /** People added to the ticket with /ticket add. */
  people: WebPerson[];
  openerBlacklist: { reason: string | null; createdAt: string } | null;
  ai: {
    enabled: boolean;
    handlesCategory: boolean;
    state: { mode: string; aiReplies: number; reason: string | null; changedBy: WebPerson | null; escalatedAt: string | null } | null;
  };
  /** True when the ticket's channel or thread no longer exists in Discord. */
  channelGone: boolean;
};

const LIVE_MESSAGE_LIMIT = 100;

async function liveConversation(guild: Guild, ticket: TicketRecord): Promise<{ channelGone: boolean; conversation: WebTicketDetail["conversation"] }> {
  const channel = await fetchGuildChannel(guild.client, guild.id, ticket.threadId ?? ticket.channelId);
  if (!channel) {
    return { channelGone: true, conversation: { source: "none", messages: [], truncated: false, error: "The ticket's channel no longer exists in Discord." } };
  }
  if (!channel.isTextBased()) {
    return { channelGone: false, conversation: { source: "none", messages: [], truncated: false, error: "The ticket's channel can't be read." } };
  }
  const batch = await channel.messages.fetch({ limit: LIVE_MESSAGE_LIMIT }).catch(() => null);
  if (!batch) {
    return {
      channelGone: false,
      conversation: { source: "none", messages: [], truncated: false, error: "Dreamliner can't read this channel's messages. Check its permissions there." },
    };
  }
  const messages = [...batch.values()].reverse().map((m) => mapTranscriptMessage(m));
  return { channelGone: false, conversation: { source: "live", messages, truncated: batch.size >= LIVE_MESSAGE_LIMIT, error: null } };
}

async function memberContextFor(guild: Guild, ticket: TicketRecord): Promise<WebTicketMemberContext | null> {
  try {
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    const data = await gatherMemberContext(guild, guildConfig, ticket.openerId, ticket.id);
    const summary = buildMemberContextSummary(data);
    const latest = data.cases.find((c) => !c.overturned && !["note", "unmute", "unban"].includes(c.type)) ?? null;
    return {
      cases: {
        active: summary.activeCases,
        total: summary.totalCases,
        overturned: summary.overturnedCases,
        notes: summary.notes,
        latest: latest ? { id: latest.id, type: latest.type, createdAt: latest.createdAt.toISOString() } : null,
      },
      openAppeal: data.openAppeal,
      passport: {
        state: data.passport.state,
        verifiedAt: data.passport.state === "verified" ? data.passport.verifiedAt.toISOString() : null,
      },
      previousTickets: {
        count: data.previousTickets.length,
        open: data.previousTickets.filter((t) => t.status !== "closed").length,
        capped: Boolean(data.previousTicketsCapped),
      },
    };
  } catch {
    return null;
  }
}

export async function getGuildTicket(guild: Guild, ticketId: number): Promise<WebTicketDetail | null> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return null;
  const pluginConfig = await getTicketsConfig(guild.id);
  const base = await toWebTicket(guild, ticket, true, pluginConfig);

  let conversation: WebTicketDetail["conversation"];
  let channelGone = false;
  if (ticket.status === "closed") {
    const transcript = await getLatestTranscriptForTicket(guild.id, ticket.id);
    conversation = transcript
      ? { source: "transcript", messages: transcript.messages, truncated: false, error: null }
      : { source: "none", messages: [], truncated: false, error: null };
    channelGone = !(await fetchGuildChannel(guild.client, guild.id, ticket.threadId ?? ticket.channelId));
  } else {
    const live = await liveConversation(guild, ticket);
    conversation = live.conversation;
    channelGone = live.channelGone;
  }

  const [memberContext, others, people, blacklist, aiModule, aiStore] = await Promise.all([
    memberContextFor(guild, ticket),
    queryTickets(guild.id, { openerId: ticket.openerId, limit: 11 }),
    Promise.all(ticket.memberIds.slice(0, 25).map(async (id) => personOrId(await resolvePerson(guild, id), id))),
    listBlacklist(guild.id),
    import("../plugins/tickets/functions/ai/responder.js"),
    import("../plugins/tickets/functions/ai/store.js"),
  ]);

  const aiConfig = aiModule.aiConfigOf(pluginConfig);
  const aiState = aiStore.getTicketAiState(ticket.id);
  const blacklisted = blacklist.find((e) => e.targetType === "user" && e.targetId === ticket.openerId) ?? null;

  return {
    ...base,
    conversation,
    mentions: resolveTranscriptMentions(guild, conversation.messages),
    memberContext,
    otherTickets: others.tickets
      .filter((t) => t.id !== ticket.id)
      .slice(0, 10)
      .map((t) => ({
        id: t.id,
        number: t.number,
        status: t.status,
        categoryLabel: labelsFor(pluginConfig, t).categoryLabel,
        createdAt: toIso(t.createdAt) ?? new Date(0).toISOString(),
        closedAt: toIso(t.closedAt),
      })),
    people,
    openerBlacklist: blacklisted ? { reason: blacklisted.reason, createdAt: blacklisted.createdAt.toISOString() } : null,
    ai: {
      enabled: aiConfig.enabled,
      handlesCategory: aiConfig.enabled && aiModule.aiHandlesCategory(aiConfig, ticket.categoryId),
      state: aiState
        ? {
            mode: aiState.mode,
            aiReplies: aiState.aiReplies,
            reason: aiState.reason,
            changedBy: aiState.changedBy ? await resolvePerson(guild, aiState.changedBy) : null,
            escalatedAt: toIso(aiState.escalatedAt),
          }
        : null,
    },
    channelGone,
  };
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
      staff: personOrId(await resolvePerson(guild, h.staffId), h.staffId),
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
 * anyone needing to run the command. `overview` is the list's stats row and status chip counts
 * (always all-time); `overall` and `handlers` follow `sinceDays`. */
export async function getGuildTicketStats(guild: Guild, opts: { sinceDays?: number } = {}) {
  const stats = await getTicketStats(guild.id);
  const topClaimers = await Promise.all(
    stats.topClaimers.map(async (entry) => ({
      staff: personOrId(await resolvePerson(guild, entry.staffId), entry.staffId),
      count: entry.count,
    })),
  );
  const handlerSummary = await getTicketHandlerStats(guild.id, {
    sinceMs: opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : undefined,
  });
  const allTime = opts.sinceDays ? await getTicketHandlerStats(guild.id) : handlerSummary;
  const handlers = await resolveHandlerStats(guild, handlerSummary);
  const all = await queryTickets(guild.id, { limit: Number.MAX_SAFE_INTEGER });
  return {
    ...stats,
    topClaimers,
    overall: handlerSummary.overall,
    handlers,
    overview: { ...summarizeTickets(all.tickets), avgFirstResponseMs: allTime.overall.avgFirstResponseMs, avgResolutionMs: allTime.overall.avgResolutionMs },
  };
}

export const TICKET_STATUS_OPTIONS = TICKET_STATUSES.map((value) => ({ value, label: TICKET_STATUS_LABELS[value] }));

export type TicketAction =
  | "close"
  | "claim"
  | "unclaim"
  | "assign"
  | "unassign"
  | "status"
  | "reopen"
  | "add"
  | "remove"
  | "priority"
  | "reply";

export type TicketActionBody = {
  reason?: string;
  /** Who to assign / add / remove. (The site always sends its session user as `userId`, the actor, so never read that as the target.) */
  targetUserId?: string;
  status?: string;
  priority?: string;
  content?: string;
};

export async function performTicketAction(
  guild: Guild,
  ticketId: number,
  action: TicketAction,
  actorId: string,
  body: TicketActionBody,
): Promise<{ ticket: WebTicket } | { error: string }> {
  const ticket = await getTicket(guild.id, ticketId);
  if (!ticket) return { error: "Ticket not found" };

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const pluginConfig = await getTicketsConfig(guild.id);
  const { category } = labelsFor(pluginConfig, ticket);
  const targetId = body.targetUserId?.trim();
  const needsOpen = ["claim", "assign", "unassign", "status", "close", "reply", "add", "remove", "priority"];
  if (ticket.status === "closed" && needsOpen.includes(action)) return { error: "This ticket is closed." };

  if (action === "claim") {
    await performClaim(guild.client, guildConfig, pluginConfig, ticket, actorId);
    // Same note the Claim button posts, so members can see someone picked it up.
    const channel = await fetchGuildChannel(guild.client, guild.id, ticket.threadId ?? ticket.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send(containerReply(buildTicketClaimedEmbed(ticket, actorId, guild.client, guildConfig.emojis))).catch(() => null);
    }
  } else if (action === "unclaim") {
    await performUnclaim(ticket);
  } else if (action === "assign") {
    if (!targetId || !SNOWFLAKE.test(targetId)) return { error: "Pick who to assign it to." };
    await performAssign(guild.client, guildConfig, pluginConfig, ticket, targetId, actorId);
  } else if (action === "unassign") {
    await performUnassign(guild.client, guildConfig, pluginConfig, ticket, actorId);
  } else if (action === "status") {
    if (!body.status || !(TICKET_STATUSES as readonly string[]).includes(body.status)) {
      return { error: `status must be one of: ${TICKET_STATUSES.join(", ")}` };
    }
    await performSetStatus(guild.client, guildConfig, pluginConfig, ticket, body.status as TicketStatus, actorId);
  } else if (action === "priority") {
    if (!body.priority || !(TICKET_PRIORITIES as readonly string[]).includes(body.priority)) {
      return { error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` };
    }
    await setPriority(guild.id, ticket.id, body.priority as TicketPriority);
  } else if (action === "close") {
    const reason = body.reason?.trim().slice(0, 500) || null;
    if (category?.require_close_reason && !reason) return { error: "This category needs a close reason." };
    await performClose(guild.client, guild, guildConfig, pluginConfig, category, ticket, actorId, reason);
  } else if (action === "reopen") {
    const result = await performReopen(guild.client, guild, ticket, actorId);
    if ("error" in result) return result;
  } else if (action === "reply") {
    const staff = await resolvePerson(guild, actorId);
    const result = await performWebReply(guild.client, guildConfig, pluginConfig, ticket, actorId, staff?.name ?? "Staff", body.content ?? "");
    if ("error" in result) return result;
  } else if (action === "add" || action === "remove") {
    if (!targetId || !SNOWFLAKE.test(targetId)) return { error: "Pick a member." };
    const updated =
      action === "add"
        ? await performAddMember(guild, ticket, targetId)
        : await performRemoveMember(guild, ticket, targetId);
    if (!updated) return { error: "Could not update ticket members" };
  }

  const refreshed = await getTicket(guild.id, ticketId);
  if (!refreshed) return { error: "Ticket not found after update" };
  return { ticket: await toWebTicket(guild, refreshed, true, pluginConfig) };
}

/** Runs one action on up to WEB_TICKET_BULK_MAX tickets, one after another, through the same
 * paths as single actions. Tickets it can't act on are reported back, not fatal. */
export async function performTicketBulk(
  guild: Guild,
  actorId: string,
  request: { ids: number[]; action: WebTicketBulkAction; reason?: string; assigneeId?: string },
): Promise<{ ok: number[]; failed: Array<{ id: number; error: string }> }> {
  const ok: number[] = [];
  const failed: Array<{ id: number; error: string }> = [];
  for (const id of request.ids) {
    try {
      if (request.action === "delete") {
        const result = await deleteGuildTicket(guild, id);
        if ("error" in result) failed.push({ id, error: result.error });
        else ok.push(id);
        continue;
      }
      const ticket = await getTicket(guild.id, id);
      if (!ticket) {
        failed.push({ id, error: "Ticket not found" });
        continue;
      }
      if (request.action === "claim" && ticket.claimedBy === actorId) {
        ok.push(id);
        continue;
      }
      const result = await performTicketAction(guild, id, request.action, actorId, {
        reason: request.reason,
        targetUserId: request.assigneeId,
      });
      if ("error" in result) failed.push({ id, error: `#${ticket.number}: ${result.error}` });
      else ok.push(id);
    } catch {
      failed.push({ id, error: "Something went wrong" });
    }
  }
  return { ok, failed };
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

export type WebTicketBlacklistEntry = {
  targetId: string;
  targetType: "user" | "role";
  reason: string | null;
  createdAt: string;
  person: WebPerson | null;
  role: { name: string; color: number } | null;
};

/** Members and roles that can't open tickets (same list as /ticket blacklist), newest first. */
export async function listGuildTicketBlacklist(guild: Guild): Promise<WebTicketBlacklistEntry[]> {
  const entries = await listBlacklist(guild.id);
  const sorted = [...entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return Promise.all(
    sorted.map(async (entry) => {
      const role = entry.targetType === "role" ? guild.roles.cache.get(entry.targetId) : null;
      return {
        targetId: entry.targetId,
        targetType: entry.targetType,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
        person: entry.targetType === "user" ? personOrId(await resolvePerson(guild, entry.targetId), entry.targetId) : null,
        role: role ? { name: role.name, color: role.color } : null,
      };
    }),
  );
}

export async function addGuildTicketBlacklist(guild: Guild, targetId: string, targetType: "user" | "role", reason?: string) {
  await addToBlacklist(guild.id, targetId, targetType, reason?.trim().slice(0, 500) || null);
  return listGuildTicketBlacklist(guild);
}

export async function removeGuildTicketBlacklist(guild: Guild, targetId: string) {
  await removeFromBlacklist(guild.id, targetId);
  return listGuildTicketBlacklist(guild);
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

/** Names for the users, roles and channels mentioned in a set of messages, from the cache only. */
export function resolveTranscriptMentions(guild: Guild, messages: TranscriptMessage[]): WebTranscriptMentions {
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
  return mentions;
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

  const mentions = resolveTranscriptMentions(guild, messages);

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
