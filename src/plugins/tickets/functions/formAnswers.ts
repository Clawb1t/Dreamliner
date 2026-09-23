import type { ModalSubmitFields } from "discord.js";
import type { TicketFormQuestion } from "../../../config/schemas/tickets.js";
import { readFormAnswer } from "../../../core/formModal.js";
import { ticketQuestionFieldId } from "../constants.js";
import type { TicketFormAnswer } from "./tickets.js";

/**
 * Reads one form question's submitted value off a modal submission and formats it into the
 * plain-string answer shape every downstream consumer (welcome-message {answer_N} templating,
 * transcripts, the ticket-opened embed) already expects. Returns null for text_display, which
 * never produces an answer (it's informational only). The parsing itself is shared with
 * Applications, see core/formModal.ts.
 */
export function formatQuestionAnswer(
  question: TicketFormQuestion,
  index: number,
  fields: ModalSubmitFields,
): TicketFormAnswer | null {
  return readFormAnswer(question, ticketQuestionFieldId(index), fields);
}
