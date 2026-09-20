import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zTicketsConfig, type TicketCategory, type TicketPanel, type TicketsConfig } from "../../../config/schemas/tickets.js";
import { resolveEphemeral } from "../../../core/ephemeral.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { hasPermission, resolveEffectivePluginConfig } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { containerReply, guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import { renderTemplate } from "../../../core/templates.js";
import { buildEmbed } from "../../persist/functions/messageBuilder.js";
import {
  TICKET_PREFIX,
  parseTicketCustomId,
  ticketCancelCloseId,
  ticketCloseModalId,
  ticketConfirmCloseId,
  ticketModalId,
  ticketOpenButtonId,
  ticketOpenSelectId,
  ticketQuestionFieldId,
} from "../constants.js";
import { canCloseTicket, createTicketForMember, performClaim, performClose, performUnclaim, ticketActionRow } from "./actions.js";
import { deleteContainer } from "./channels.js";
import { buildTicketClaimedEmbed } from "./embeds.js";
import { formatQuestionAnswer } from "./formAnswers.js";
import type { TicketFormAnswer } from "./tickets.js";
import { getLogger } from "../../../core/logger.js";
import { defaultTranslator, translatorFor, type Translator } from "../../../i18n/index.js";
const log = getLogger("tickets");

export type BuiltPanelMessage = {
  content?: string;
  embeds: import("discord.js").EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
};

function parseButtonStyle(style: string): ButtonStyle {
  switch (style) {
    case "secondary":
      return ButtonStyle.Secondary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Primary;
  }
}

/** Builds the {content, embeds, components} payload for a ticket panel, per its configured style. */
export function buildPanelMessage(panel: TicketPanel, guild?: import("discord.js").Guild, t: Translator = defaultTranslator): BuiltPanelMessage {
  const embed = buildEmbed(panel.embed, {
    client: guild?.client as Client,
    guild: guild as import("discord.js").Guild,
    channel: undefined as unknown as import("discord.js").GuildTextBasedChannel,
  });
  const content = panel.content ? renderTemplate(panel.content, { guild }) : undefined;

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const enabledCategories = panel.categories;

  // The schema only requires a non-empty label via a zod superRefine (see config/schemas/
  // tickets.ts), which — unlike a plain minLength — doesn't make it into the exported JSON
  // Schema the dashboard's client-side validation runs against, so the dashboard doesn't
  // actually stop you from saving a category with a blank label (e.g. right after "Add
  // category", before you've filled it in). Discord's own button/select-menu builders require
  // a 1-100 character label and throw synchronously otherwise, which — with no label here to
  // fall back to — would take down the *entire* panel's post, including its other, valid
  // categories. Falling back to a placeholder keeps a half-configured category from doing that.
  function categoryLabel(category: TicketCategory, maxLength: number): string {
    return category.label.trim().slice(0, maxLength) || t("tickets.panel.categoryFallback", "Category");
  }

  if (panel.style === "select") {
    const select = new StringSelectMenuBuilder()
      .setCustomId(ticketOpenSelectId(panel.id))
      .setPlaceholder(t("tickets.panel.selectCategoryPlaceholder", "Select a ticket category..."))
      .addOptions(
        enabledCategories.slice(0, 25).map((category) => {
          const option = { label: categoryLabel(category, 100), value: category.id, description: category.description.slice(0, 100) || undefined };
          const emoji = parseComponentEmoji(category.emoji);
          return emoji ? { ...option, emoji } : option;
        }),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  } else {
    let row = new ActionRowBuilder<ButtonBuilder>();
    for (const category of enabledCategories.slice(0, 5)) {
      if (row.components.length >= 5) {
        components.push(row);
        row = new ActionRowBuilder<ButtonBuilder>();
      }
      const button = new ButtonBuilder()
        .setCustomId(ticketOpenButtonId(panel.id, category.id))
        .setLabel(categoryLabel(category, 80))
        .setStyle(parseButtonStyle(category.button_style));
      const emoji = parseComponentEmoji(category.emoji);
      if (emoji) button.setEmoji(emoji);
      row.addComponents(button);
    }
    if (row.components.length) components.push(row);
  }

  return { content, embeds: embed ? [embed] : [], components };
}

/** Posts a panel's message to its configured channel. Returns the new message id, or null on failure. */
export async function postPanel(client: Client, _guildId: string, panel: TicketPanel, t: Translator = defaultTranslator): Promise<string | null> {
  if (!panel.channel_id) return null;
  const channel = await client.channels.fetch(panel.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  const guild = "guild" in channel ? (channel.guild as import("discord.js").Guild) : undefined;
  let built: BuiltPanelMessage;
  try {
    // discord.js's component builders (setLabel, addOptions, etc.) validate synchronously and
    // throw on bad input — a malformed category (or embed) would otherwise crash out of this
    // function entirely instead of failing gracefully like everything else here does.
    built = buildPanelMessage(panel, guild, t);
  } catch (error) {
    log.error(`[tickets] Failed to build panel ${panel.id}'s message:`, error);
    return null;
  }
  const message = await channel
    .send({
      ...(built.content ? { content: built.content } : {}),
      embeds: built.embeds,
      components: built.components,
    })
    .catch((error) => {
      // Swallowed everywhere this return value is used (dashboard/slash command both just show a
      // generic "could not post" message) — log it here so the real Discord API rejection reason
      // (bad button/select-menu payload, missing permissions, etc.) is visible in the bot's console.
      log.error(`[tickets] Failed to post panel ${panel.id} to channel ${panel.channel_id}:`, error);
      return null;
    });
  return message?.id ?? null;
}

async function resolveTicketsConfig(guildConfig: import("../../../config/schemas/guild.js").GuildConfig, member: GuildMember, _channelId: string): Promise<TicketsConfig> {
  return zTicketsConfig.parse(
    await resolveEffectivePluginConfig(member.guild.id, "tickets", member, guildConfig),
  );
}

function findPanelAndCategory(config: TicketsConfig, panelId: string, categoryId: string): { panel: TicketPanel; category: TicketCategory } | null {
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) return null;
  const category = panel.categories.find((c) => c.id === categoryId);
  if (!category) return null;
  return { panel, category };
}

async function openOrPromptModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  panelId: string,
  categoryId: string,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return;
  const { t } = await translatorFor(interaction.user.id);
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply(t("tickets.pluginDisabledTitle", "Plugin disabled"), t("tickets.pluginDisabledBody", "Tickets are disabled for this server."), true));
    return;
  }
  const member = interaction.member as GuildMember;
  const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
  const found = findPanelAndCategory(config, panelId, categoryId);
  if (!found || !found.panel.enabled) {
    await interaction.reply(resultReply(t("tickets.unavailableTitle", "Unavailable"), t("tickets.panelUnavailableBody", "This ticket panel is no longer available."), true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return;
  }
  const { category, panel } = found;

  if (category.form_questions.length > 0) {
    const modal = new ModalBuilder().setCustomId(ticketModalId(panelId, categoryId)).setTitle(category.label.slice(0, 45));
    for (const [index, question] of category.form_questions.slice(0, 5).entries()) {
      const fieldId = ticketQuestionFieldId(index);

      // Unchanged from before modal component support existed. Every question saved before
      // that point has no `type` and defaults to "text", so this branch (and only this branch)
      // handles it exactly as it always has.
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
        modal.addTextDisplayComponents(new TextDisplayBuilder().setContent((question.content?.trim() || question.label).slice(0, 4000)));
        continue;
      }

      const label = new LabelBuilder().setLabel(question.label.slice(0, 45));
      const min = question.min_values ?? (question.required ? 1 : 0);
      const max = question.max_values ?? 1;
      const options = (question.options ?? []).slice(0, 25).map((option) => ({
        label: option.label.slice(0, 100),
        value: option.value.slice(0, 100),
        ...(option.description ? { description: option.description.slice(0, 100) } : {}),
      }));

      switch (question.type) {
        case "string_select":
          label.setStringSelectMenuComponent(
            new StringSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required).addOptions(options),
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
            new MentionableSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required),
          );
          break;
        case "channel_select":
          label.setChannelSelectMenuComponent(
            new ChannelSelectMenuBuilder().setCustomId(fieldId).setMinValues(min).setMaxValues(max).setRequired(question.required),
          );
          break;
        case "radio_group":
          label.setRadioGroupComponent(
            new RadioGroupBuilder().setCustomId(fieldId).addOptions(options).setRequired(question.required),
          );
          break;
        case "checkbox_group":
          label.setCheckboxGroupComponent(
            new CheckboxGroupBuilder().setCustomId(fieldId).addOptions(options).setMinValues(min).setMaxValues(max).setRequired(question.required),
          );
          break;
        case "checkbox":
          // No .setRequired() on CheckboxBuilder: a single checkbox has no "required" concept
          // in Discord's own component API.
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
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await createTicketForMember({
    client: interaction.client,
    guild: interaction.guild,
    member,
    panel,
    category,
    guildConfig,
    pluginConfig: config,
    t,
  });
  if ("error" in result) {
    await interaction.editReply(resultEdit(t("tickets.cannotOpenTicketTitle", "Cannot open ticket"), result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return;
  }
  const target = result.ticket.threadId ?? result.ticket.channelId;
  await interaction.editReply(resultEdit(t("tickets.ticketOpenedTitle", "Ticket opened"), t("tickets.ticketReadyBody", "Your ticket is ready: <#{target}>.", { target }), guildResultOptions(interaction.client, guildConfig, { tone: "success", emoji: "<:icons_ticket:1544417593191047179>" })));
}

export async function handleTicketButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_PREFIX)) return false;
  const parsed = parseTicketCustomId(interaction.customId);
  if (!parsed) return false;
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply(t("tickets.serverOnlyTitle", "Server only"), t("tickets.useInServerBody", "Use this in a server."), true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply(t("tickets.pluginDisabledTitle", "Plugin disabled"), t("tickets.pluginDisabledBody", "Tickets are disabled for this server."), true));
    return true;
  }
  const member = interaction.member as GuildMember;
  const ephemeral = resolveEphemeral(guildConfig);

  if (parsed.kind === "open") {
    await openOrPromptModal(interaction, parsed.panelId, parsed.categoryId);
    return true;
  }

  const { getTicket } = await import("./tickets.js");

  if (parsed.kind === "claim" || parsed.kind === "unclaim") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply(t("tickets.notFoundTitle", "Not found"), t("tickets.ticketNoLongerExistsBody", "That ticket no longer exists."), true));
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    if (!(await hasPermission(interaction.guildId!, "tickets", "can_claim", member, guildConfig))) {
      await interaction.reply(resultReply(t("tickets.permissionDeniedTitle", "Permission denied"), t("tickets.cannotClaimBody", "You cannot claim tickets."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    await interaction.deferUpdate();
    if (parsed.kind === "claim") {
      await performClaim(interaction.client, guildConfig, config, ticket, member.id);
      const embed = buildTicketClaimedEmbed(ticket, member.id, interaction.client, guildConfig.emojis, t);
      await interaction.message.edit({ components: [ticketActionRow(ticket.id, true, t)] }).catch(() => null);
      if ("send" in interaction.channel!) await (interaction.channel as import("discord.js").TextChannel).send(containerReply(embed)).catch(() => null);
    } else {
      await performUnclaim(ticket);
      await interaction.message.edit({ components: [ticketActionRow(ticket.id, false, t)] }).catch(() => null);
    }
    return true;
  }

  if (parsed.kind === "close") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply(t("tickets.notFoundTitle", "Not found"), t("tickets.ticketNoLongerExistsBody", "That ticket no longer exists."), true));
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    const isOpener = ticket.openerId === member.id;
    const isStaff = await hasPermission(interaction.guildId!, "tickets", "can_close_others", member, guildConfig);
    const canCloseOwn = isOpener && (await hasPermission(interaction.guildId!, "tickets", "can_close", member, guildConfig));
    const allowed = canCloseTicket(category?.close_permission ?? "either", canCloseOwn, isStaff);
    if (!allowed) {
      await interaction.reply(resultReply(t("tickets.permissionDeniedTitle", "Permission denied"), t("tickets.cannotCloseThisBody", "You cannot close this ticket."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ticketConfirmCloseId(ticket.id)).setLabel(t("tickets.button.confirmClose", "Confirm close")).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(ticketCancelCloseId(ticket.id)).setLabel(t("tickets.button.cancel", "Cancel")).setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply(resultReply(t("tickets.closeThisTicketTitle", "Close this ticket?"), t("tickets.closeArchiveBody", "This will archive the ticket and generate a transcript."), true, guildResultOptions(interaction.client, guildConfig), [row]));
    return true;
  }

  if (parsed.kind === "closeno") {
    await interaction.update(resultEdit(t("tickets.cancelledTitle", "Cancelled"), t("tickets.ticketStaysOpenBody", "This ticket stays open."), guildResultOptions(interaction.client, guildConfig)));
    return true;
  }

  if (parsed.kind === "closeyes") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.update(resultEdit(t("tickets.notFoundTitle", "Not found"), t("tickets.ticketNoLongerExistsBody", "That ticket no longer exists."), guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    if (category?.require_close_reason) {
      const modal = new ModalBuilder()
        .setCustomId(ticketCloseModalId(ticket.id))
        .setTitle(t("tickets.modal.closeTicketTitle", "Close ticket"))
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(`${TICKET_PREFIX}reason`)
              .setLabel(t("tickets.modal.reasonLabel", "Reason"))
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(500),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }
    await interaction.update(resultEdit(t("tickets.closingTitle", "Closing..."), t("tickets.generatingTranscriptBody", "Generating transcript and closing the ticket."), guildResultOptions(interaction.client, guildConfig)));
    await performClose(interaction.client, interaction.guild, guildConfig, config, category, ticket, member.id, null, t);
    return true;
  }

  if (parsed.kind === "delete") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply(t("tickets.notFoundTitle", "Not found"), t("tickets.ticketNoLongerExistsBody", "That ticket no longer exists."), true));
      return true;
    }
    if (ticket.status !== "closed") {
      await interaction.reply(resultReply(t("tickets.notClosedTitle", "Not closed"), t("tickets.closeBeforeDeleteBody", "Close this ticket before deleting its channel."), true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    if (!(await hasPermission(interaction.guildId!, "tickets", "can_delete", member, guildConfig))) {
      await interaction.reply(resultReply(t("tickets.permissionDeniedTitle", "Permission denied"), t("tickets.cannotDeleteBody", "You cannot delete tickets."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    await interaction.reply(resultReply(t("tickets.deletingTitle", "Deleting..."), t("tickets.channelBeingDeletedBody", "This channel is being deleted. The ticket and its transcript stay on record."), true, guildResultOptions(interaction.client, guildConfig)));
    await deleteContainer(interaction.guild, ticket);
    return true;
  }

  return false;
}

export async function handleTicketSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_PREFIX)) return false;
  const parsed = parseTicketCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "openmenu") return false;
  const categoryId = interaction.values[0];
  if (!categoryId) return true;
  await openOrPromptModal(interaction, parsed.panelId, categoryId);
  return true;
}

export async function handleTicketModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_PREFIX)) return false;
  const parsed = parseTicketCustomId(interaction.customId);
  if (!parsed) return false;
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply(t("tickets.serverOnlyTitle", "Server only"), t("tickets.useInServerBody", "Use this in a server."), true));
    return true;
  }
  const member = interaction.member as GuildMember;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply(t("tickets.pluginDisabledTitle", "Plugin disabled"), t("tickets.pluginDisabledBody", "Tickets are disabled for this server."), true));
    return true;
  }

  if (parsed.kind === "modal") {
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const found = findPanelAndCategory(config, parsed.panelId, parsed.categoryId);
    if (!found) {
      await interaction.reply(resultReply(t("tickets.unavailableTitle", "Unavailable"), t("tickets.panelUnavailableBody", "This ticket panel is no longer available."), true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const { panel, category } = found;
    const answers: TicketFormAnswer[] = category.form_questions
      .slice(0, 5)
      .map((q, index) => formatQuestionAnswer(q, index, interaction.fields))
      .filter((a): a is TicketFormAnswer => a !== null);

    await interaction.deferReply({ ephemeral: true });
    const result = await createTicketForMember({
      client: interaction.client,
      guild: interaction.guild,
      member,
      panel,
      category,
      guildConfig,
      pluginConfig: config,
      formResponses: answers,
      t,
    });
    if ("error" in result) {
      await interaction.editReply(resultEdit(t("tickets.cannotOpenTicketTitle", "Cannot open ticket"), result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const target = result.ticket.threadId ?? result.ticket.channelId;
    await interaction.editReply(resultEdit(t("tickets.ticketOpenedTitle", "Ticket opened"), t("tickets.ticketReadyBody", "Your ticket is ready: <#{target}>.", { target }), guildResultOptions(interaction.client, guildConfig, { tone: "success", emoji: "<:icons_ticket:1544417593191047179>" })));
    return true;
  }

  if (parsed.kind === "closemodal") {
    const { getTicket } = await import("./tickets.js");
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply(t("tickets.notFoundTitle", "Not found"), t("tickets.ticketNoLongerExistsBody", "That ticket no longer exists."), true));
      return true;
    }
    const reason = interaction.fields.getTextInputValue(`${TICKET_PREFIX}reason`).trim();
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    await interaction.reply(resultReply(t("tickets.closingTitle", "Closing..."), t("tickets.generatingTranscriptBody", "Generating transcript and closing the ticket."), true, guildResultOptions(interaction.client, guildConfig)));
    await performClose(interaction.client, interaction.guild, guildConfig, config, category, ticket, member.id, reason, t);
    return true;
  }

  return false;
}
