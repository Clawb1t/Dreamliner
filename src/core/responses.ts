import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  DiscordAPIError,
  MessageFlags,
  type AttachmentBuilder,
  type MessageMentionOptions,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
  type TopLevelComponentData,
} from "discord.js";
import { buildResultEmbed, type ResultContainer, type ResultEmbedOptions } from "./embeds.js";
import type { SlashCommandContext } from "./types.js";
import { supportLinkRow } from "./docsUrl.js";
import { getLogger } from "./logger.js";
import { censorProfanity } from "./profanityFilter.js";

export { guildResultOptions } from "./embeds.js";

const log = getLogger("interactions");

function withEphemeral(ephemeral: boolean): Pick<InteractionReplyOptions, "flags"> | Record<string, never> {
  return ephemeral ? { flags: MessageFlags.Ephemeral } : {};
}

function componentsFlags(ephemeral: boolean): number {
  return MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
}

/**
 * A raw ping (role/user mention) as its own top-level text component, for the rare case a
 * message needs to actually notify someone. Components V2 messages can't carry `content`, so
 * this is the only place a mention can live — but text alone isn't enough: every builder in
 * this file also sets `allowedMentions: { parse: [] }` (see NO_PING), so a caller that wants
 * this component to actually ping must additionally override `allowedMentions` on the final
 * payload it sends (e.g. `{ ...payload, allowedMentions: { users: [id] } }`) — see
 * bot_customisation/functions/handlers.ts or suggestions/functions/service.ts for the pattern.
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
  allowedMentions: MessageMentionOptions;
};

/**
 * Every mention parsed out (no ping, no highlight) by default — command responses regularly
 * quote a member's `<@id>` for display (e.g. "Muted @user for ..."), and without this Discord
 * treats that exactly like a real ping: a notification, and the "mentions you" highlight for
 * whoever it names. `pingComponent()` is the deliberate opt-back-in for the rare response that
 * should actually notify someone — its callers pass their own `allowedMentions` override.
 */
const NO_PING: MessageMentionOptions = { parse: [] };

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

/**
 * Rewrites a caught error into a clearer message when Discord rejected the action because the
 * bot itself is missing a permission — every command's generic catch block (and every button/
 * select/modal handler's) funnels its error through this, so "I don't have Manage Roles" is
 * never reported to the user as an opaque "unexpected error occurred".
 */
export function describeActionError(error: unknown, fallback: string): string {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return "I don't have the Discord permission needed to do that. Check that my role has the right permissions (and any channel-specific overwrites), then try again.";
    }
    if (error.code === 50001) {
      return "I don't have access to do that here — check my role's permissions for this channel.";
    }
  }
  return fallback;
}

/**
 * The one place every catch block should reply through. Discord.js gives you three different
 * ways to respond to an interaction depending on whether it's already been deferred/replied to
 * (`reply` vs `editReply` vs `followUp`) — getting that wrong is exactly how a command that
 * defers and then throws leaves the user staring at a permanently "thinking..." message instead
 * of an error. This picks the right one automatically, and never itself throws.
 */
export async function replyWithError(
  interaction: RepliableInteraction,
  message: string,
  options?: ResultEmbedOptions,
): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(resultEdit("Error", message, options, [supportLinkRow()]));
    } else {
      await interaction.reply(resultReply("Error", message, true, options, [supportLinkRow()]));
    }
  } catch (err) {
    log.error("Failed to deliver error reply to user:", err);
  }
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
    allowedMentions: NO_PING,
  };
}

export function containerEdit(
  container: ResultContainer,
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[],
): ContainerPayload {
  return {
    components: toTopLevel(container, components),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PING,
  };
}

type ContainerEntry = { container: ResultContainer; row?: ActionRowBuilder<MessageActionRowComponentBuilder> };

/** Multiple top-level containers stacked in a single message (e.g. a track container plus a
 *  separate "manage online" container) — Components V2 messages allow more than one top-level
 *  container, so this avoids sending a second, separate message just to say something extra. */
export function containersReply(entries: ContainerEntry[], ephemeral = false): ContainerPayload {
  return {
    components: entries.map((e) => e.container.toContainerComponent(e.row ? [e.row.toJSON()] : undefined)),
    flags: componentsFlags(ephemeral),
    allowedMentions: NO_PING,
  };
}

export function containersEdit(entries: ContainerEntry[]): ContainerPayload {
  return {
    components: entries.map((e) => e.container.toContainerComponent(e.row ? [e.row.toJSON()] : undefined)),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PING,
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
  return { content: censorProfanity(content), allowedMentions: NO_PING, ...withEphemeral(ephemeral) };
}

export function contentEdit(content: string): InteractionEditReplyOptions {
  return { content: censorProfanity(content), allowedMentions: NO_PING };
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
