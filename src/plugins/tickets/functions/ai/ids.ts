/** Component ids for the AI Responder's buttons on its replies. */
export const TICKET_AI_PREFIX = "dl:ticket:ai:";

export type TicketAiButton = "staff" | "solved";

export function ticketAiButtonId(action: TicketAiButton, ticketId: number): string {
  return `${TICKET_AI_PREFIX}${action}:${ticketId}`;
}

export function parseTicketAiButtonId(customId: string): { action: TicketAiButton; ticketId: number } | null {
  const match = /^dl:ticket:ai:(staff|solved):(\d+)$/.exec(customId);
  return match ? { action: match[1] as TicketAiButton, ticketId: Number(match[2]) } : null;
}
