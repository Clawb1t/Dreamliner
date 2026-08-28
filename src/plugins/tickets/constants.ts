/** Custom-ID prefix for every ticket-plugin message component, mirroring suggestions/constants.ts. */
export const TICKET_PREFIX = "dl:ticket:";

export function ticketOpenButtonId(panelId: string, categoryId: string): string {
  return `${TICKET_PREFIX}open:${panelId}:${categoryId}`;
}

export function ticketOpenSelectId(panelId: string): string {
  return `${TICKET_PREFIX}openmenu:${panelId}`;
}

export function ticketModalId(panelId: string, categoryId: string): string {
  return `${TICKET_PREFIX}modal:${panelId}:${categoryId}`;
}

export function ticketClaimId(ticketId: number): string {
  return `${TICKET_PREFIX}claim:${ticketId}`;
}

export function ticketUnclaimId(ticketId: number): string {
  return `${TICKET_PREFIX}unclaim:${ticketId}`;
}

export function ticketCloseId(ticketId: number): string {
  return `${TICKET_PREFIX}close:${ticketId}`;
}

export function ticketConfirmCloseId(ticketId: number): string {
  return `${TICKET_PREFIX}closeyes:${ticketId}`;
}

export function ticketCancelCloseId(ticketId: number): string {
  return `${TICKET_PREFIX}closeno:${ticketId}`;
}

export function ticketCloseModalId(ticketId: number): string {
  return `${TICKET_PREFIX}closemodal:${ticketId}`;
}

/** Shown on the closed-ticket message — deletes the Discord channel/thread (keeps the ticket record and transcript). */
export function ticketDeleteId(ticketId: number): string {
  return `${TICKET_PREFIX}delete:${ticketId}`;
}

/** Modal text-input field custom ID for the Nth (0-indexed) form question. */
export function ticketQuestionFieldId(index: number): string {
  return `${TICKET_PREFIX}q:${index}`;
}

export type ParsedTicketCustomId =
  | { kind: "open"; panelId: string; categoryId: string }
  | { kind: "openmenu"; panelId: string }
  | { kind: "modal"; panelId: string; categoryId: string }
  | { kind: "claim"; ticketId: number }
  | { kind: "unclaim"; ticketId: number }
  | { kind: "close"; ticketId: number }
  | { kind: "closeyes"; ticketId: number }
  | { kind: "closeno"; ticketId: number }
  | { kind: "closemodal"; ticketId: number }
  | { kind: "delete"; ticketId: number };

const UUID = "[0-9a-fA-F-]{36}";

export function parseTicketCustomId(customId: string): ParsedTicketCustomId | null {
  if (!customId.startsWith(TICKET_PREFIX)) return null;
  const rest = customId.slice(TICKET_PREFIX.length);

  let match = new RegExp(`^open:(${UUID}):(${UUID})$`).exec(rest);
  if (match) return { kind: "open", panelId: match[1]!, categoryId: match[2]! };

  match = new RegExp(`^openmenu:(${UUID})$`).exec(rest);
  if (match) return { kind: "openmenu", panelId: match[1]! };

  match = new RegExp(`^modal:(${UUID}):(${UUID})$`).exec(rest);
  if (match) return { kind: "modal", panelId: match[1]!, categoryId: match[2]! };

  match = /^(claim|unclaim|close|closeyes|closeno|closemodal|delete):(\d+)$/.exec(rest);
  if (match) {
    const kind = match[1] as "claim" | "unclaim" | "close" | "closeyes" | "closeno" | "closemodal" | "delete";
    return { kind, ticketId: Number(match[2]) } as ParsedTicketCustomId;
  }

  return null;
}
