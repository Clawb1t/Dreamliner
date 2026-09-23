import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { applicationApplyId } from "../constants.js";
import { loadApplicationsConfig, openingVars, PLUGIN } from "./config.js";

const log = getLogger("applications");

const BUTTON_STYLES: Record<ApplicationOpening["button"]["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function applyButtonRow(opening: ApplicationOpening): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(applicationApplyId(opening.id))
    .setLabel((opening.button.label.trim() || "Apply").slice(0, 80))
    .setStyle(BUTTON_STYLES[opening.button.style] ?? ButtonStyle.Primary)
    // A paused opening keeps its post but the button greys out until applications reopen.
    .setDisabled(!opening.accepting || !opening.enabled);
  const emoji = parseComponentEmoji(opening.button.emoji);
  if (emoji) button.setEmoji(emoji);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/** The opening's post: its text + embed rendered by the welcomer builder, plus the apply button. */
export async function buildOpeningPost(guild: Guild, opening: ApplicationOpening): Promise<MessageCreateOptions> {
  const me = guild.members.me;
  const built = await buildWelcomePayload(
    { enabled: true, content: opening.message.content, embed: opening.message.embed, card: zWelcomeCardConfig.parse({}) },
    { guildId: guild.id, member: me, user: me?.user ?? guild.client.user, guild, extra: openingVars(opening) },
  );
  return {
    ...built.payload,
    components: [applyButtonRow(opening)],
    // Posts announce an opening; they should never ping anyone.
    allowedMentions: { parse: [] },
  };
}

/**
 * Posts an opening (from the saved config), or edits its existing post in place when it's still
 * there, then stores the message ID back into the config.
 */
export async function publishOpening(
  guild: Guild,
  openingId: string,
  actorId: string,
): Promise<{ messageId: string; updated: boolean } | { error: string }> {
  const config = loadApplicationsConfig(await configManager.getEffectiveConfig(guild.id));
  const opening = config.openings.find((o) => o.id === openingId);
  if (!opening) return { error: "Opening not found. Save your changes first." };
  if (!opening.channel_id) return { error: "Pick a channel to post this opening in first." };

  const channel = await guild.channels.fetch(opening.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { error: "That channel is missing or isn't a text channel." };
  }

  let payload: MessageCreateOptions;
  try {
    payload = await buildOpeningPost(guild, opening);
  } catch (error) {
    // discord.js builders validate synchronously (bad emoji, empty label...), so surface it.
    log.error(`[applications] Failed to build post for opening ${opening.id}:`, error);
    return { error: "This opening's post couldn't be built. Check its button emoji and embed." };
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
    log.error(`[applications] Failed to post opening ${opening.id} in ${opening.channel_id}:`, error);
    return null;
  });
  if (!sent) return { error: "Couldn't post in that channel. Check my permissions there." };

  const openings = config.openings.map((o) => (o.id === openingId ? { ...o, message_id: sent.id } : o));
  await configManager.patchPluginConfig(guild.id, PLUGIN, { openings }, actorId);
  return { messageId: sent.id, updated: false };
}
