import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type AttachmentBuilder,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type TopLevelComponentData,
} from "discord.js";
import { buildResultEmbed, type ResultContainer, type ResultEmbedOptions } from "./embeds.js";
import type { SlashCommandContext } from "./types.js";

export { guildResultOptions } from "./embeds.js";

function withEphemeral(ephemeral: boolean): Pick<InteractionReplyOptions, "flags"> | Record<string, never> {
  return ephemeral ? { flags: MessageFlags.Ephemeral } : {};
}

function componentsFlags(ephemeral: boolean): number {
  return MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
}

/**
 * A raw ping (role/user mention) as its own top-level text component, for the rare case a
 * Components V2 message needs to actually notify someone — Components V2 messages can't carry
 * `content`, and mentions inside a container's own text are suppressed by the `allowedMentions`
 * most builders set, so the ping needs to live in its own unsuppressed component.
 */
export function pingComponent(mention: string): TopLevelComponentData {
  return { type: ComponentType.TextDisplay, content: mention };
}

/**
 * References a non-image attachment (e.g. a `.txt` export) so it actually shows up — Components
 * V2 messages don't auto-render bare `files`, image or not; every attachment needs an explicit
 * component pointing at its `attachment://filename` URL. Pass the result as one of `embedReply`'s
 * (etc.) trailing `components` rows, or straight into `toContainerComponent`.
 */
export function fileComponent(filename: string): TopLevelComponentData {
  return { type: ComponentType.File, file: { url: `attachment://${filename}` } };
}

/**
 * The plain payload shape `containerReply`/`containerEdit` return. Deliberately not typed as
 * `InteractionReplyOptions`/`InteractionEditReplyOptions` (which is what those two are used to
 * build in most call sites) — this is generic enough to also drop straight into a raw
 * `channel.send(...)`/`message.edit(...)` call, which is why so many places reuse these two
 * instead of hand-assembling `{ components, flags }` themselves. `flags` is a plain `number` so
 * it structurally satisfies every one of Discord.js's differently-narrowed `flags` fields.
 */
export type ContainerPayload = {
  components: TopLevelComponentData[];
  flags: number;
};

function toTopLevel(
  container: ResultContainer,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): TopLevelComponentData[] {
  const rows = components?.length ? components.map((row) => row.toJSON()) : undefined;
  return [container.toContainerComponent(rows)];
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
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionReplyOptions {
  return containerReply(buildResultEmbed(title, details, options), ephemeral, components);
}

export function resultEdit(
  title: string,
  details?: string,
  options?: ResultEmbedOptions,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionEditReplyOptions {
  return containerEdit(buildResultEmbed(title, details, options), components);
}

export function embedReply(
  container: ResultContainer,
  ephemeral = false,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionReplyOptions {
  return containerReply(container, ephemeral, components);
}

export function embedEdit(
  container: ResultContainer,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionEditReplyOptions {
  return containerEdit(container, components);
}

export function containerReply(
  container: ResultContainer,
  ephemeral = false,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): ContainerPayload {
  return {
    components: toTopLevel(container, components),
    flags: componentsFlags(ephemeral),
  };
}

export function containerEdit(
  container: ResultContainer,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): ContainerPayload {
  return {
    components: toTopLevel(container, components),
    flags: MessageFlags.IsComponentsV2,
  };
}

export function embedWithFilesReply(
  container: ResultContainer,
  files: AttachmentBuilder[],
  ephemeral = false,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionReplyOptions {
  return {
    ...containerReply(container, ephemeral, components),
    files,
  };
}

export function embedWithFilesEdit(
  container: ResultContainer,
  files: AttachmentBuilder[],
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): InteractionEditReplyOptions {
  return {
    ...containerEdit(container, components),
    files,
  };
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
