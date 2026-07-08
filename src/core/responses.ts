import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type APIEmbed,
  type AttachmentBuilder,
  type EmbedBuilder,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from "discord.js";
import { buildResultEmbed, type ResultEmbedOptions } from "./embeds.js";
import type { SlashCommandContext } from "./types.js";

export { guildResultOptions } from "./embeds.js";

function withEphemeral(ephemeral: boolean): Pick<InteractionReplyOptions, "flags"> | Record<string, never> {
  return ephemeral ? { flags: MessageFlags.Ephemeral } : {};
}

export function deferReplyOptions(ephemeral = false): InteractionDeferReplyOptions {
  return ephemeral ? { flags: MessageFlags.Ephemeral } : {};
}

export function slashResultOptions(
  ctx: SlashCommandContext,
  extra?: Partial<ResultEmbedOptions>,
): ResultEmbedOptions {
  return { client: ctx.client, emojis: ctx.guildConfig.emojis, ...extra };
}

export function resultReply(
  title: string,
  details?: string,
  ephemeral = false,
  options?: ResultEmbedOptions,
): InteractionReplyOptions {
  return embedReply(buildResultEmbed(title, details, options), ephemeral);
}

export function resultEdit(
  title: string,
  details?: string,
  options?: ResultEmbedOptions,
): InteractionEditReplyOptions {
  return embedEdit(buildResultEmbed(title, details, options));
}

export function embedReply(embed: APIEmbed | EmbedBuilder, ephemeral = false): InteractionReplyOptions {
  return { embeds: [embed], ...withEphemeral(ephemeral) };
}

export function embedEdit(embed: APIEmbed | EmbedBuilder): InteractionEditReplyOptions {
  return { embeds: [embed] };
}

export function embedWithFilesReply(
  embed: APIEmbed | EmbedBuilder,
  files: AttachmentBuilder[],
  ephemeral = false,
): InteractionReplyOptions {
  return { embeds: [embed], files, ...withEphemeral(ephemeral) };
}

export function contentReply(content: string, ephemeral = false): InteractionReplyOptions {
  return { content, ...withEphemeral(ephemeral) };
}

export function contentEdit(content: string): InteractionEditReplyOptions {
  return { content };
}

export function paginationRow(customIdPrefix: string, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev:${page}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next:${page}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );
}

/** @deprecated Use resultReply for Zeppelin-style embed output */
export function plainReply(title: string, text: string, ephemeral = false, options?: ResultEmbedOptions): InteractionReplyOptions {
  return resultReply(title, text, ephemeral, options);
}

/** @deprecated Use resultEdit for Zeppelin-style embed output */
export function plainEdit(title: string, text: string, options?: ResultEmbedOptions): InteractionEditReplyOptions {
  return resultEdit(title, text, options);
}
