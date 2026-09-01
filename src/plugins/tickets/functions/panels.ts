import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
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
import { hasPluginPermission, resolvePluginConfig } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";
import { renderTemplate } from "../../../core/templates.js";
import { buildEmbed } from "../../persist/functions/messageBuilder.js";
import { ticketsDefaultOverrides } from "../defaultOverrides.js";
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
import type { TicketFormAnswer } from "./tickets.js";

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
export function buildPanelMessage(panel: TicketPanel, guild?: import("discord.js").Guild): BuiltPanelMessage {
  const embed = buildEmbed(panel.embed, {
    client: guild?.client as Client,
    guild: guild as import("discord.js").Guild,
    channel: undefined as unknown as import("discord.js").GuildTextBasedChannel,
  });
  const content = panel.content ? renderTemplate(panel.content, { guild }) : undefined;

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const enabledCategories = panel.categories;

  if (panel.style === "select") {
    const select = new StringSelectMenuBuilder()
      .setCustomId(ticketOpenSelectId(panel.id))
      .setPlaceholder("Select a ticket category...")
      .addOptions(
        enabledCategories.slice(0, 25).map((category) => {
          const option = { label: category.label.slice(0, 100), value: category.id, description: category.description.slice(0, 100) || undefined };
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
        .setLabel(category.label.slice(0, 80))
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
export async function postPanel(client: Client, _guildId: string, panel: TicketPanel): Promise<string | null> {
  if (!panel.channel_id) return null;
  const channel = await client.channels.fetch(panel.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  const guild = "guild" in channel ? (channel.guild as import("discord.js").Guild) : undefined;
  const built = buildPanelMessage(panel, guild);
  const message = await channel
    .send({
      ...(built.content ? { content: built.content } : {}),
      embeds: built.embeds,
      components: built.components,
    })
    .catch(() => null);
  return message?.id ?? null;
}

async function resolveTicketsConfig(guildConfig: import("../../../config/schemas/guild.js").GuildConfig, member: GuildMember, channelId: string): Promise<TicketsConfig> {
  return zTicketsConfig.parse(
    resolvePluginConfig(guildConfig, "tickets", ticketsDefaultOverrides, member, channelId, null),
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
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply("Plugin disabled", "Tickets are disabled for this server.", true));
    return;
  }
  const member = interaction.member as GuildMember;
  const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
  const found = findPanelAndCategory(config, panelId, categoryId);
  if (!found || !found.panel.enabled) {
    await interaction.reply(resultReply("Unavailable", "This ticket panel is no longer available.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return;
  }
  const { category, panel } = found;

  if (category.form_questions.length > 0) {
    const modal = new ModalBuilder().setCustomId(ticketModalId(panelId, categoryId)).setTitle(category.label.slice(0, 45));
    for (const [index, question] of category.form_questions.slice(0, 5).entries()) {
      const field = new TextInputBuilder()
        .setCustomId(ticketQuestionFieldId(index))
        .setLabel(question.label)
        .setStyle(question.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(question.required)
        .setMaxLength(question.max_length);
      if (question.placeholder) field.setPlaceholder(question.placeholder);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
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
  });
  if ("error" in result) {
    await interaction.editReply(resultEdit("Cannot open ticket", result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return;
  }
  const target = result.ticket.threadId ?? result.ticket.channelId;
  await interaction.editReply(resultEdit("Ticket opened", `Your ticket is ready: <#${target}>.`, guildResultOptions(interaction.client, guildConfig, { tone: "success", emoji: "<:icons_ticket:1544417593191047179>" })));
}

export async function handleTicketButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(TICKET_PREFIX)) return false;
  const parsed = parseTicketCustomId(interaction.customId);
  if (!parsed) return false;
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply("Plugin disabled", "Tickets are disabled for this server.", true));
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
      await interaction.reply(resultReply("Not found", "That ticket no longer exists.", true));
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    if (!hasPluginPermission(guildConfig, "tickets", "can_claim", member, interaction.channelId ?? "", null, ticketsDefaultOverrides)) {
      await interaction.reply(resultReply("Permission denied", "You cannot claim tickets.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    await interaction.deferUpdate();
    if (parsed.kind === "claim") {
      await performClaim(interaction.client, guildConfig, config, ticket, member.id);
      const embed = buildTicketClaimedEmbed(ticket, member.id, interaction.client, guildConfig.emojis);
      await interaction.message.edit({ components: [ticketActionRow(ticket.id, true)] }).catch(() => null);
      if ("send" in interaction.channel!) await (interaction.channel as import("discord.js").TextChannel).send({ embeds: [embed] }).catch(() => null);
    } else {
      await performUnclaim(ticket);
      await interaction.message.edit({ components: [ticketActionRow(ticket.id, false)] }).catch(() => null);
    }
    return true;
  }

  if (parsed.kind === "close") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply("Not found", "That ticket no longer exists.", true));
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    const isOpener = ticket.openerId === member.id;
    const isStaff = hasPluginPermission(guildConfig, "tickets", "can_close_others", member, interaction.channelId ?? "", null, ticketsDefaultOverrides);
    const canCloseOwn = isOpener && hasPluginPermission(guildConfig, "tickets", "can_close", member, interaction.channelId ?? "", null, ticketsDefaultOverrides);
    const allowed = canCloseTicket(category?.close_permission ?? "either", canCloseOwn, isStaff);
    if (!allowed) {
      await interaction.reply(resultReply("Permission denied", "You cannot close this ticket.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ticketConfirmCloseId(ticket.id)).setLabel("Confirm close").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(ticketCancelCloseId(ticket.id)).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ ...resultReply("Close this ticket?", "This will archive the ticket and generate a transcript.", true, guildResultOptions(interaction.client, guildConfig)), components: [row] });
    return true;
  }

  if (parsed.kind === "closeno") {
    await interaction.update({ ...resultEdit("Cancelled", "This ticket stays open.", guildResultOptions(interaction.client, guildConfig)), components: [] });
    return true;
  }

  if (parsed.kind === "closeyes") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.update({ ...resultEdit("Not found", "That ticket no longer exists.", guildResultOptions(interaction.client, guildConfig, { tone: "error" })), components: [] });
      return true;
    }
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    if (category?.require_close_reason) {
      const modal = new ModalBuilder()
        .setCustomId(ticketCloseModalId(ticket.id))
        .setTitle("Close ticket")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(`${TICKET_PREFIX}reason`)
              .setLabel("Reason")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(500),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }
    await interaction.update({ ...resultEdit("Closing...", "Generating transcript and closing the ticket.", guildResultOptions(interaction.client, guildConfig)), components: [] });
    await performClose(interaction.client, interaction.guild, guildConfig, config, category, ticket, member.id, null);
    return true;
  }

  if (parsed.kind === "delete") {
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply("Not found", "That ticket no longer exists.", true));
      return true;
    }
    if (ticket.status !== "closed") {
      await interaction.reply(resultReply("Not closed", "Close this ticket before deleting its channel.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    if (!hasPluginPermission(guildConfig, "tickets", "can_delete", member, interaction.channelId ?? "", null, ticketsDefaultOverrides)) {
      await interaction.reply(resultReply("Permission denied", "You cannot delete tickets.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    await interaction.reply(resultReply("Deleting...", "This channel is being deleted. The ticket and its transcript stay on record.", true, guildResultOptions(interaction.client, guildConfig)));
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
  if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }
  const member = interaction.member as GuildMember;
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId!);
  if (!pluginEnabled(guildConfig, "tickets")) {
    await interaction.reply(resultReply("Plugin disabled", "Tickets are disabled for this server.", true));
    return true;
  }

  if (parsed.kind === "modal") {
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const found = findPanelAndCategory(config, parsed.panelId, parsed.categoryId);
    if (!found) {
      await interaction.reply(resultReply("Unavailable", "This ticket panel is no longer available.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const { panel, category } = found;
    const answers: TicketFormAnswer[] = category.form_questions.slice(0, 5).map((q, index) => ({
      questionId: q.id,
      label: q.label,
      answer: interaction.fields.getTextInputValue(ticketQuestionFieldId(index)).trim(),
    }));

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
    });
    if ("error" in result) {
      await interaction.editReply(resultEdit("Cannot open ticket", result.error, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    const target = result.ticket.threadId ?? result.ticket.channelId;
    await interaction.editReply(resultEdit("Ticket opened", `Your ticket is ready: <#${target}>.`, guildResultOptions(interaction.client, guildConfig, { tone: "success", emoji: "<:icons_ticket:1544417593191047179>" })));
    return true;
  }

  if (parsed.kind === "closemodal") {
    const { getTicket } = await import("./tickets.js");
    const ticket = await getTicket(interaction.guildId!, parsed.ticketId);
    if (!ticket) {
      await interaction.reply(resultReply("Not found", "That ticket no longer exists.", true));
      return true;
    }
    const reason = interaction.fields.getTextInputValue(`${TICKET_PREFIX}reason`).trim();
    const config = await resolveTicketsConfig(guildConfig, member, interaction.channelId ?? "");
    const panel = config.panels.find((p) => p.id === ticket.panelId);
    const category = panel?.categories.find((c) => c.id === ticket.categoryId);
    await interaction.reply(resultReply("Closing...", "Generating transcript and closing the ticket.", true, guildResultOptions(interaction.client, guildConfig)));
    await performClose(interaction.client, interaction.guild, guildConfig, config, category, ticket, member.id, reason);
    return true;
  }

  return false;
}
