import type { ModalSubmitFields } from "discord.js";
import type { TicketFormQuestion } from "../../../config/schemas/tickets.js";
import { ticketQuestionFieldId } from "../constants.js";
import type { TicketFormAnswer } from "./tickets.js";

function formatOptionValues(question: TicketFormQuestion, values: readonly string[]): string {
  if (!values.length) return "";
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  return values.map((value) => byValue.get(value) ?? value).join(", ");
}

/**
 * Reads one form question's submitted value off a modal submission and formats it into the
 * plain-string answer shape every downstream consumer (welcome-message {answer_N} templating,
 * transcripts, the ticket-opened embed) already expects, so none of them need to change to
 * support the new component types. Returns null for text_display, which never produces an
 * answer (it's informational only).
 */
export function formatQuestionAnswer(
  question: TicketFormQuestion,
  index: number,
  fields: ModalSubmitFields,
): TicketFormAnswer | null {
  const fieldId = ticketQuestionFieldId(index);
  let answer = "";

  switch (question.type) {
    case "text_display":
      return null;

    case "text":
      answer = fields.getTextInputValue(fieldId).trim();
      break;

    case "string_select":
      answer = formatOptionValues(question, fields.getStringSelectValues(fieldId));
      break;

    case "radio_group": {
      const value = fields.getRadioGroup(fieldId);
      answer = value ? formatOptionValues(question, [value]) : "";
      break;
    }

    case "checkbox_group":
      answer = formatOptionValues(question, fields.getCheckboxGroup(fieldId));
      break;

    case "checkbox":
      answer = fields.getCheckbox(fieldId) ? "Yes" : "No";
      break;

    case "user_select": {
      const users = fields.getSelectedUsers(fieldId);
      answer = users ? [...users.values()].map((user) => user.username).join(", ") : "";
      break;
    }

    case "role_select": {
      const roles = fields.getSelectedRoles(fieldId);
      answer = roles ? [...roles.values()].map((role) => role?.name).filter((name): name is string => Boolean(name)).join(", ") : "";
      break;
    }

    case "mentionable_select": {
      const selected = fields.getSelectedMentionables(fieldId);
      const roleNames = selected ? [...selected.roles.values()].map((role) => role?.name).filter((name): name is string => Boolean(name)) : [];
      const userNames = selected ? [...selected.users.values()].map((user) => user.username) : [];
      answer = [...roleNames, ...userNames].join(", ");
      break;
    }

    case "channel_select": {
      const channels = fields.getSelectedChannels(fieldId);
      answer = channels ? [...channels.values()].map((channel) => `#${channel.name}`).join(", ") : "";
      break;
    }

    case "file_upload": {
      const files = fields.getUploadedFiles(fieldId);
      answer = files ? [...files.values()].map((file) => file.name).join(", ") : "";
      break;
    }
  }

  return { questionId: question.id, label: question.label, answer };
}
