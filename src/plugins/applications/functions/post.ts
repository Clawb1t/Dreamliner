import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js";
import type { ApplicationOpening } from "../../../config/schemas/applications.js";
import { configManager } from "../../../config/manager.js";
import { zWelcomeCardConfig } from "../../../config/schemas/welcome.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { getLogger } from "../../../core/logger.js";
import { buildWelcomePayload } from "../../welcome_message/functions/messageBuilder.js";
import { applicationApplyId, formAttendeesId, formRsvpId } from "../constants.js";
import { loadApplicationsConfig, openingVars, PLUGIN } from "./config.js";
import { rsvpCounts, type RsvpCounts } from "./store.js";

const log = getLogger("applications");

const BUTTON_STYLES: Record<ApplicationOpening["button"]["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Whether the form is outside its open window right now (the button greys out). */
export function outsideWindow(opening: ApplicationOpening, now = Date.now()): boolean {
  const opens = Date.parse(opening.opens_at ?? "");
  const closes = Date.parse(opening.closes_at ?? "");
  return (Number.isFinite(opens) && now < opens) || (Number.isFinite(closes) && now >= closes);
}

function closedNow(opening: ApplicationOpening): boolean {
  return !opening.accepting || !opening.enabled || outsideWindow(opening);
}

function applyButtonRow(opening: ApplicationOpening): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(applicationApplyId(opening.id))
    .setLabel((opening.button.label.trim() || "Apply").slice(0, 80))
    .setStyle(BUTTON_STYLES[opening.button.style] ?? ButtonStyle.Primary)
    // A paused form keeps its post but the button greys out until it reopens.
    .setDisabled(closedNow(opening));
  const emoji = parseComponentEmoji(opening.button.emoji);
  if (emoji) button.setEmoji(emoji);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/** Going / Maybe / Can't go, plus Who's going. */
export function rsvpButtonRow(opening: ApplicationOpening, counts: RsvpCounts | null): ActionRowBuilder<ButtonBuilder> {
  const closed = closedNow(opening);
  const event = opening.event;
  const full = event.capacity > 0 && (counts?.going ?? 0) >= event.capacity;
  const goingLabel = `${event.going_label.trim() || "Going"}${event.show_counts && counts ? ` (${counts.going})` : ""}`;
  const going = new ButtonBuilder()
    .setCustomId(formRsvpId(opening.id, "going"))
    .setLabel((full && !event.waitlist ? `${event.going_label.trim() || "Going"} (full)` : goingLabel).slice(0, 80))
    .setStyle(ButtonStyle.Success)
    .setDisabled(closed);
  const emoji = parseComponentEmoji(opening.button.emoji);
  if (emoji) going.setEmoji(emoji);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(going);
  if (event.allow_maybe) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(formRsvpId(opening.id, "maybe"))
        .setLabel(`${event.maybe_label.trim() || "Maybe"}${event.show_counts && counts ? ` (${counts.maybe})` : ""}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(closed),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(formRsvpId(opening.id, "not_going"))
      .setLabel((event.not_going_label.trim() || "Can't go").slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed),
    new ButtonBuilder().setCustomId(formAttendeesId(opening.id)).setLabel("Who's going").setStyle(ButtonStyle.Secondary),
  );
  return row;
}

/** "12 of 30 going · 3 on the waitlist" for an RSVP post. */
export function rsvpSummary(opening: ApplicationOpening, counts: RsvpCounts): string {
  const capacity = opening.event.capacity;
  const parts = [capacity > 0 ? `${counts.going} of ${capacity} going` : `${counts.going} going`];
  if (opening.event.allow_maybe && counts.maybe) parts.push(`${counts.maybe} maybe`);
  if (counts.waitlisted) parts.push(`${counts.waitlisted} on the waitlist`);
  return parts.join(" · ");
}

/** The form's post: its text + embed rendered by the welcomer builder, plus its button(s). */
export async function buildOpeningPost(guild: Guild, opening: ApplicationOpening): Promise<MessageCreateOptions> {
  const me = guild.members.me;
  const counts = opening.kind === "rsvp" ? rsvpCounts(guild.id, opening.id) : null;
  const extra: Record<string, string> = { ...openingVars(opening) };
  if (counts) {
    extra.going = String(counts.going);
    extra.maybe = String(counts.maybe);
    extra.waitlisted = String(counts.waitlisted);
    extra.spots_left = opening.event.capacity > 0 ? String(Math.max(0, opening.event.capacity - counts.going)) : "";
  }
  const built = await buildWelcomePayload(
    { enabled: true, content: opening.message.content, embed: opening.message.embed, card: zWelcomeCardConfig.parse({}) },
    { guildId: guild.id, member: me, user: me?.user ?? guild.client.user, guild, extra },
  );
  const payload: MessageCreateOptions = { ...built.payload };
  if (counts && opening.event.show_counts) {
    const summary = rsvpSummary(opening, counts);
    const first = payload.embeds?.[0];
    if (first instanceof EmbedBuilder) first.addFields({ name: "Responses", value: summary });
    else payload.content = [payload.content, `-# ${summary}`].filter(Boolean).join("\n");
  }
  return {
    ...payload,
    components: [counts ? rsvpButtonRow(opening, counts) : applyButtonRow(opening)],
    // Posts announce a form; they should never ping anyone.
    allowedMentions: { parse: [] },
  };
}

/** Deletes the Discord posts of forms that a config save removed (best effort). */
export async function deleteRemovedOpeningPosts(
  guild: Guild,
  previous: ApplicationOpening[],
  next: ApplicationOpening[],
): Promise<void> {
  const kept = new Set(next.map((o) => o.id));
  for (const opening of previous) {
    if (kept.has(opening.id) || !opening.channel_id || !opening.message_id) continue;
    const channel = await guild.channels.fetch(opening.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    const message = await channel.messages.fetch(opening.message_id).catch(() => null);
    if (message?.author.id === guild.client.user.id) await message.delete().catch(() => null);
  }
}

/** Re-renders a published post in place (RSVP counts after someone answers). Best effort. */
export async function refreshOpeningPost(guild: Guild, opening: ApplicationOpening): Promise<void> {
  if (!opening.channel_id || !opening.message_id) return;
  const channel = await guild.channels.fetch(opening.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(opening.message_id).catch(() => null);
  if (!message?.editable) return;
  const payload = await buildOpeningPost(guild, opening).catch(() => null);
  if (!payload) return;
  await message
    .edit({ content: payload.content ?? null, embeds: payload.embeds ?? [], components: payload.components, allowedMentions: payload.allowedMentions })
    .catch(() => null);
}

/**
 * Posts a form (from the saved config), or edits its existing post in place when it's still
 * there, then stores the message ID back into the config.
 */
export async function publishOpening(
  guild: Guild,
  openingId: string,
  actorId: string,
): Promise<{ messageId: string; updated: boolean } | { error: string }> {
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const opening = config.openings.find((o) => o.id === openingId);
  if (!opening) return { error: "Form not found. Save your changes first." };
  if (!opening.channel_id) return { error: "Pick a channel to post this form in first." };

  const channel = await guild.channels.fetch(opening.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { error: "That channel is missing or isn't a text channel." };
  }

  let payload: MessageCreateOptions;
  try {
    payload = await buildOpeningPost(guild, opening);
  } catch (error) {
    // discord.js builders validate synchronously (bad emoji, empty label...), so surface it.
    log.error(`[applications] Failed to build post for form ${opening.id}:`, error);
    return { error: "This form's post couldn't be built. Check its button emoji and embed." };
  }

  if (opening.message_id) {
    const existing = await channel.messages.fetch(opening.message_id).catch(() => null);
    if (existing?.editable) {
      const edited = await existing
        .edit({
          content: payload.content ?? null,
          embeds: payload.embeds ?? [],
          components: payload.components,
          allowedMentions: payload.allowedMentions,
        })
        .catch(() => null);
      if (edited) return { messageId: edited.id, updated: true };
    }
  }

  const sent = await (channel as SendableChannels).send(payload).catch((error) => {
    log.error(`[applications] Failed to post form ${opening.id} in ${opening.channel_id}:`, error);
    return null;
  });
  if (!sent) return { error: "Couldn't post in that channel. Check my permissions there." };

  const openings = config.openings.map((o) => (o.id === openingId ? { ...o, message_id: sent.id } : o));
  await configManager.patchPluginConfig(guild.id, PLUGIN, { openings }, actorId);
  return { messageId: sent.id, updated: false };
}
