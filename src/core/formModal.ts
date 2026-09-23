import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  CheckboxBuilder,
  CheckboxGroupBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  RadioGroupBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type Attachment,
  type ModalSubmitFields,
} from "discord.js";
import type { TicketFormQuestion } from "../config/schemas/tickets.js";

/**
 * Custom modal forms built from dashboard-configured questions (the `zTicketFormQuestion` shape),
 * shared by Tickets and Applications. Discord caps a modal at 5 top-level components, so callers
 * pass at most `MODAL_PAGE_SIZE` questions per modal.
 */

export type FormQuestion = TicketFormQuestion;
export type FormAnswer = { questionId: string; label: string; answer: string };

export const MODAL_PAGE_SIZE = 5;

/** Splits a form into modal-sized pages. */
export function paginateQuestions<T>(questions: T[], pageSize = MODAL_PAGE_SIZE): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < questions.length; i += pageSize) pages.push(questions.slice(i, i + pageSize));
  return pages;
}

/** Builds a modal for up to 5 questions. `fieldId(index)` names each question's component. */
export function buildFormModal(options: {
  customId: string;
  title: string;
  questions: FormQuestion[];
  fieldId: (index: number) => string;
}): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(options.customId).setTitle(options.title.slice(0, 45));

  for (const [index, question] of options.questions.slice(0, MODAL_PAGE_SIZE).entries()) {
    const fieldId = options.fieldId(index);

    // Plain text input in a classic action row, exactly as questions saved before modal
    // component support existed (no `type`, defaulting to "text") have always rendered.
    if (question.type === "text") {
      const field = new TextInputBuilder()
        .setCustomId(fieldId)
        .setLabel(question.label)
        .setStyle(question.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(question.required)
        .setMaxLength(question.max_length);
      if (question.placeholder) field.setPlaceholder(question.placeholder);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
      continue;
    }

    // Purely informational: no customId, no answer, not wrapped in a Label.
    if (question.type === "text_display") {
      modal.addTextDisplayComponents(
        new TextDisplayBuilder().setContent((question.content?.trim() || question.label).slice(0, 4000)),
      );
      continue;
    }

    const label = new LabelBuilder().setLabel(question.label.slice(0, 45));
    const min = question.min_values ?? (question.required ? 1 : 0);
    const max = question.max_values ?? 1;
    const choices = (question.options ?? []).slice(0, 25).map((option) => ({
      label: option.label.slice(0, 100),
      value: option.value.slice(0, 100),
      ...(option.description ? { description: option.description.slice(0, 100) } : {}),
    }));

    switch (question.type) {
      case "string_select":
        label.setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(fieldId)
            .setMinValues(min)
            .setMaxValues(max)
            .setRequired(question.required)
            .addOptions(choices),
        );
        break;
      case "user_select":
        label.setUserSelectMenuComponent(
          new UserSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required),
        );
        break;
      case "role_select":
        label.setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required),
        );
        break;
      case "mentionable_select":
        label.setMentionableSelectMenuComponent(
          new MentionableSelectMenuBuilder()
            .setCustomId(fieldId)
            .setMinValues(min)
            .setMaxValues(max)
            .setRequired(question.required),
        );
        break;
      case "channel_select":
        label.setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required),
        );
        break;
      case "radio_group":
        label.setRadioGroupComponent(new RadioGroupBuilder().setCustomId(fieldId).addOptions(choices).setRequired(question.required));
        break;
      case "checkbox_group":
        label.setCheckboxGroupComponent(
          new CheckboxGroupBuilder()
            .setCustomId(fieldId)
            .addOptions(choices)
            .setMinValues(min)
            .setMaxValues(max)
            .setRequired(question.required),
        );
        break;
      case "checkbox":
        // No .setRequired() on CheckboxBuilder: a single checkbox has no "required" concept in
        // Discord's own component API.
        label.setCheckboxComponent(new CheckboxBuilder().setCustomId(fieldId));
        break;
      case "file_upload":
        label.setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(fieldId)
            .setMinValues(question.min_values ?? 0)
            .setMaxValues(question.max_values ?? 1)
            .setRequired(question.required),
        );
        break;
    }
    modal.addLabelComponents(label);
  }

  return modal;
}

function formatOptionValues(question: FormQuestion, values: readonly string[]): string {
  if (!values.length) return "";
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  return values.map((value) => byValue.get(value) ?? value).join(", ");
}

/**
 * Reads one question's submitted value off a modal submission as a plain-string answer (option
 * labels instead of values, names instead of IDs). Returns null for text_display, which never
 * produces an answer.
 */
export function readFormAnswer(question: FormQuestion, fieldId: string, fields: ModalSubmitFields): FormAnswer | null {
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
      answer = roles
        ? [...roles.values()]
            .map((role) => role?.name)
            .filter((name): name is string => Boolean(name))
            .join(", ")
        : "";
      break;
    }

    case "mentionable_select": {
      const selected = fields.getSelectedMentionables(fieldId);
      const roleNames = selected
        ? [...selected.roles.values()].map((role) => role?.name).filter((name): name is string => Boolean(name))
        : [];
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

/** Files attached to a file_upload question, for callers that re-post them somewhere. */
export function readFormFiles(question: FormQuestion, fieldId: string, fields: ModalSubmitFields): Attachment[] {
  if (question.type !== "file_upload") return [];
  const files = fields.getUploadedFiles(fieldId);
  return files ? [...files.values()] : [];
}
