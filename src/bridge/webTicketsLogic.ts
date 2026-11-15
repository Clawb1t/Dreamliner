import type { TicketRecord } from "../plugins/tickets/functions/tickets.js";
import { escalationSilenceStart, isAwaitingStaffReply } from "../plugins/tickets/functions/escalation.js";

/**
 * Pure helpers behind the dashboard's View Tickets page (list filters, sorting, the stats row).
 * No Discord or database access here, so it's all unit-testable.
 */

/** The status chips on the list. "unclaimed" and "claimed" are both open tickets. */
export const WEB_TICKET_VIEWS = ["open", "unclaimed", "claimed", "closed", "all"] as const;
export type WebTicketView = (typeof WEB_TICKET_VIEWS)[number];

export const WEB_TICKET_SORTS = ["newest", "oldest", "waiting", "active"] as const;
export type WebTicketSort = (typeof WEB_TICKET_SORTS)[number];

export function parseTicketView(raw: string | null | undefined): WebTicketView | undefined {
  return (WEB_TICKET_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as WebTicketView) : undefined;
}

export function parseTicketSort(raw: string | null | undefined): WebTicketSort {
  return (WEB_TICKET_SORTS as readonly string[]).includes(raw ?? "") ? (raw as WebTicketSort) : "newest";
}

export function ticketMatchesView(ticket: Pick<TicketRecord, "status" | "claimedBy">, view: WebTicketView): boolean {
  switch (view) {
    case "open":
      return ticket.status === "open";
    case "unclaimed":
      return ticket.status === "open" && !ticket.claimedBy;
    case "claimed":
      return ticket.status === "open" && Boolean(ticket.claimedBy);
    case "closed":
      return ticket.status === "closed";
    default:
      return true;
  }
}

type WaitFields = Pick<TicketRecord, "status" | "subStatus" | "lastStaffReplyAt" | "lastActivityAt" | "createdAt" | "escalationStep">;

/** Whether an open ticket is waiting on staff right now, since when, and if an SLA step has already fired. */
export function ticketWaitInfo(ticket: WaitFields): { awaitingStaff: boolean; waitingSince: Date | null; slaBreached: boolean } {
  if (ticket.status !== "open") return { awaitingStaff: false, waitingSince: null, slaBreached: false };
  const awaitingStaff = isAwaitingStaffReply(ticket);
  return {
    awaitingStaff,
    waitingSince: awaitingStaff ? escalationSilenceStart(ticket) : null,
    // escalationStep goes back to -1 on every staff reply, so >= 0 means a step fired since.
    slaBreached: awaitingStaff && ticket.escalationStep >= 0,
  };
}

/**
 * Sorts a ticket list. "waiting" puts open tickets that are waiting on staff first, longest wait
 * first, then the rest newest first; "active" is by last activity.
 */
export function sortTickets<T extends WaitFields & Pick<TicketRecord, "id">>(tickets: T[], sort: WebTicketSort): T[] {
  const list = [...tickets];
  if (sort === "oldest") return list.sort((a, b) => a.id - b.id);
  if (sort === "active") return list.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || b.id - a.id);
  if (sort === "waiting") {
    return list.sort((a, b) => {
      const wa = ticketWaitInfo(a).waitingSince;
      const wb = ticketWaitInfo(b).waitingSince;
      if (wa && wb) return wa.getTime() - wb.getTime() || a.id - b.id;
      if (wa) return -1;
      if (wb) return 1;
      return b.id - a.id;
    });
  }
  return list.sort((a, b) => b.id - a.id);
}

const DAY_MS = 86_400_000;

export type WebTicketOverview = {
  total: number;
  byView: Record<WebTicketView, number>;
  /** Open tickets waiting on a staff reply right now. */
  waitingOnStaff: number;
  /** Open tickets waiting on staff where an SLA escalation step already fired. */
  slaBreaches: number;
  closedLast24h: number;
  closedLast30d: number;
  openedLast30d: number;
  /** Tickets opened per day, last 30 days, oldest first (UTC days, today last). */
  daily: number[];
  /** Team Control feedback ratings (1 to 5) stored on tickets. */
  satisfaction: { average: number | null; count: number };
};

/** The numbers on top of View Tickets, from every ticket in the server. */
export function summarizeTickets(
  tickets: Array<WaitFields & Pick<TicketRecord, "claimedBy" | "closedAt" | "ratingScore">>,
  now = Date.now(),
): WebTicketOverview {
  const byView: Record<WebTicketView, number> = { open: 0, unclaimed: 0, claimed: 0, closed: 0, all: tickets.length };
  let waitingOnStaff = 0;
  let slaBreaches = 0;
  let closedLast24h = 0;
  let closedLast30d = 0;
  let openedLast30d = 0;
  const daily = new Array<number>(30).fill(0);
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const ratings: number[] = [];

  for (const ticket of tickets) {
    for (const view of ["open", "unclaimed", "claimed", "closed"] as const) {
      if (ticketMatchesView(ticket, view)) byView[view] += 1;
    }
    const wait = ticketWaitInfo(ticket);
    if (wait.awaitingStaff) waitingOnStaff += 1;
    if (wait.slaBreached) slaBreaches += 1;
    if (ticket.status === "closed" && ticket.closedAt) {
      const age = now - ticket.closedAt.getTime();
      if (age <= DAY_MS) closedLast24h += 1;
      if (age <= 30 * DAY_MS) closedLast30d += 1;
    }
    const created = ticket.createdAt.getTime();
    if (now - created <= 30 * DAY_MS) openedLast30d += 1;
    const dayIndex = 29 - Math.floor((todayStart - Math.floor(created / DAY_MS) * DAY_MS) / DAY_MS);
    if (dayIndex >= 0 && dayIndex < 30) daily[dayIndex]! += 1;
    if (typeof ticket.ratingScore === "number" && ticket.ratingScore > 0) ratings.push(ticket.ratingScore);
  }

  const average = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  return {
    total: tickets.length,
    byView,
    waitingOnStaff,
    slaBreaches,
    closedLast24h,
    closedLast30d,
    openedLast30d,
    daily,
    satisfaction: { average, count: ratings.length },
  };
}

/** Bulk actions the list can run on many tickets at once. */
export const WEB_TICKET_BULK_ACTIONS = ["close", "claim", "assign", "delete"] as const;
export type WebTicketBulkAction = (typeof WEB_TICKET_BULK_ACTIONS)[number];
export const WEB_TICKET_BULK_MAX = 25;

/** Validates a bulk request body. Ids are de-duplicated and capped. */
export function parseTicketBulkBody(
  body: unknown,
): { ids: number[]; action: WebTicketBulkAction; reason?: string; assigneeId?: string } | { error: string } {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== "string" || !(WEB_TICKET_BULK_ACTIONS as readonly string[]).includes(action)) {
    return { error: `action must be one of: ${WEB_TICKET_BULK_ACTIONS.join(", ")}` };
  }
  const ids = Array.isArray(raw.ids)
    ? [...new Set(raw.ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (ids.length === 0) return { error: "Pick at least one ticket." };
  if (ids.length > WEB_TICKET_BULK_MAX) return { error: `Up to ${WEB_TICKET_BULK_MAX} tickets at a time.` };
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 500) : undefined;
  const assigneeId = typeof raw.assigneeId === "string" && /^\d{15,22}$/.test(raw.assigneeId) ? raw.assigneeId : undefined;
  if (action === "assign" && !assigneeId) return { error: "Pick who to assign them to." };
  return { ids, action: action as WebTicketBulkAction, reason, assigneeId };
}
