import { baseEmbed, discordTs, embedField, setEmbedAuthor, type ResultContainer } from "../../../core/embeds.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import type { Client, Guild } from "discord.js";
import type { TicketCategory } from "../../../config/schemas/tickets.js";
import type { TicketRecord } from "./tickets.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

/**
 * Substitute {user}, {guild}, {category}, and {answer_1}..{answer_N} in a ticket
 * message template. {user} resolves to a real mention, but since this is only ever
 * used in embed descriptions/fields (not message `content`), Discord will not send
 * a ping for it — mentions inside embeds are inert.
 */
export function renderTicketTemplate(
  template: string,
  ticket: TicketRecord,
  guild: Guild,
  category: TicketCategory | undefined,
  t: Translator = defaultTranslator,
): string {
  let out = template
    .replace(/\{user\}/g, `<@${ticket.openerId}>`)
    .replace(/\{guild\}/g, guild.name)
    .replace(/\{category\}/g, category?.label ?? t("tickets.embed.unknownCategory", "Unknown"));
  out = out.replace(/\{answer_(\d+)\}/g, (_match, indexStr: string) => {
    const index = Number(indexStr) - 1;
    return ticket.formResponses[index]?.answer ?? "";
  });
  return out;
}

export function buildTicketOpenedEmbed(
  ticket: TicketRecord,
  category: TicketCategory | undefined,
  guild: Guild,
  client: Client,
  emojis?: EmojisConfig,
  t: Translator = defaultTranslator,
): ResultContainer {
  const embed = setEmbedAuthor(baseEmbed(), t("tickets.embed.ticketNumTitle", "Ticket #{num}", { num: ticket.number }), client, {
    tone: "success",
    emojis,
    emoji: "<:icons_ticket:1544417593191047179>",
  });
  const template =
    category?.welcome_message?.trim() ||
    t("tickets.embed.defaultWelcome", "Thanks for reaching out, {user}! Support will be with you shortly.", {
      user: `<@${ticket.openerId}>`,
    });
  embed.setDescription(renderTicketTemplate(template, ticket, guild, category, t));
  embed.addFields(
    embedField(t("tickets.embed.openedBy", "Opened by"), `<@${ticket.openerId}>`, true),
    embedField(t("tickets.embed.category", "Category"), category?.label ?? t("tickets.embed.unknownCategory", "Unknown"), true),
    embedField(t("tickets.embed.priority", "Priority"), ticket.priority, true),
  );
  if (ticket.formResponses.length) {
    for (const answer of ticket.formResponses.slice(0, 5)) {
      embed.addFields(embedField(answer.label, answer.answer.slice(0, 1024) || t("tickets.embed.noAnswer", "*(no answer)*")));
    }
  }
  return embed;
}

export function buildTicketClaimedEmbed(
  ticket: TicketRecord,
  staffId: string,
  client: Client,
  emojis?: EmojisConfig,
  t: Translator = defaultTranslator,
): ResultContainer {
  return setEmbedAuthor(baseEmbed(), t("tickets.embed.ticketClaimedTitle", "Ticket #{num} claimed", { num: ticket.number }), client, {
    tone: "neutral",
    emojis,
    emoji: "<:icons_hammer:1544417299937763348>",
  }).setDescription(
    t("tickets.embed.nowHandling", "<@{staffId}> is now handling this ticket.", { staffId }),
  );
}

export function buildTranscriptEmbed(
  ticket: TicketRecord,
  guildName: string,
  messageCount: number,
  client: Client,
  emojis?: EmojisConfig,
  guildIconURL?: string | null,
  t: Translator = defaultTranslator,
): ResultContainer {
  const embed = setEmbedAuthor(baseEmbed(), t("tickets.embed.ticketTranscriptTitle", "Ticket #{num} transcript", { num: ticket.number }), client, {
    tone: "neutral",
    emojis,
    thumbnailURL: guildIconURL ?? undefined,
  });
  embed.setDescription(
    t(
      "tickets.embed.transcriptDescription",
      "Here's a copy of the conversation from your ticket in **{guild}**. The full transcript is attached below.",
      { guild: guildName },
    ),
  );
  embed.addFields(
    embedField(t("tickets.embed.opened", "Opened"), discordTs(ticket.createdAt), true),
    embedField(t("tickets.embed.closed", "Closed"), ticket.closedAt ? discordTs(ticket.closedAt) : "—", true),
    embedField(t("tickets.embed.messages", "Messages"), String(messageCount), true),
  );
  return embed;
}

export function buildTicketClosedEmbed(
  ticket: TicketRecord,
  actorId: string,
  reason: string | null | undefined,
  client: Client,
  emojis?: EmojisConfig,
  t: Translator = defaultTranslator,
): ResultContainer {
  const embed = setEmbedAuthor(baseEmbed(), t("tickets.embed.ticketClosedTitle", "Ticket #{num} closed", { num: ticket.number }), client, {
    tone: "error",
    emojis,
    emoji: "<:icons_archive:1544417474823590008>",
  });
  embed.addFields(
    embedField(t("tickets.embed.closedBy", "Closed by"), `<@${actorId}>`, true),
    embedField(t("tickets.embed.opened", "Opened"), discordTs(ticket.createdAt), true),
  );
  if (reason?.trim()) embed.addFields(embedField(t("tickets.embed.reason", "Reason"), reason.slice(0, 1024)));
  return embed;
}
