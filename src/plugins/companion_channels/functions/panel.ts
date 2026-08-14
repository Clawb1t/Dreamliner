import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { CompanionChannelsConfig } from "../../../config/schemas/companion.js";
import { featureEnabled } from "./config.js";

export const COMPANION_SETTINGS_ID = "companion:settings";
export const COMPANION_ACCESS_ID = "companion:access";
export const COMPANION_PICK_PREFIX = "companion:pick:";
export const COMPANION_MODAL_PREFIX = "companion:modal:";
export const COMPANION_REGION_ID = "companion:region";

export function buildCompanionInterface(config: CompanionChannelsConfig) {
  const settingOptions = [
    featureEnabled(config, "name") ? { label: "Name", value: "name", description: "Rename this room" } : null,
    featureEnabled(config, "limit")
      ? { label: "User limit", value: "limit", description: "Cap how many people can join" }
      : null,
    featureEnabled(config, "bitrate")
      ? { label: "Bitrate", value: "bitrate", description: "Change audio quality" }
      : null,
    featureEnabled(config, "status")
      ? { label: "Status", value: "status", description: "Set the voice channel status" }
      : null,
    featureEnabled(config, "region")
      ? { label: "Region", value: "region", description: "Change the voice region" }
      : null,
    featureEnabled(config, "nsfw") ? { label: "Toggle NSFW", value: "nsfw", description: "Mark as NSFW" } : null,
    featureEnabled(config, "text")
      ? { label: "Text channel", value: "text", description: "Create or remove a linked text channel" }
      : null,
    featureEnabled(config, "lfm")
      ? { label: "Looking for members", value: "lfm", description: "Post in the LFM channel" }
      : null,
  ].filter((option): option is { label: string; value: string; description: string } => Boolean(option));

  const accessOptions = [
    featureEnabled(config, "lock") ? { label: "Lock", value: "lock", description: "Block new joins" } : null,
    featureEnabled(config, "lock") ? { label: "Unlock", value: "unlock", description: "Allow new joins" } : null,
    featureEnabled(config, "ghost")
      ? { label: "Ghost", value: "ghost", description: "Hide from the channel list" }
      : null,
    featureEnabled(config, "ghost")
      ? { label: "Unghost", value: "unghost", description: "Show in the channel list" }
      : null,
    featureEnabled(config, "permit")
      ? { label: "Permit", value: "permit", description: "Allow a user or role in" }
      : null,
    featureEnabled(config, "reject")
      ? { label: "Reject", value: "reject", description: "Block and kick a user or role" }
      : null,
    featureEnabled(config, "invite")
      ? { label: "Invite", value: "invite", description: "DM someone an invite" }
      : null,
    featureEnabled(config, "transfer")
      ? { label: "Transfer", value: "transfer", description: "Give ownership to someone else" }
      : null,
    featureEnabled(config, "claim")
      ? { label: "Claim", value: "claim", description: "Take ownership if the owner left" }
      : null,
  ].filter((option): option is { label: string; value: string; description: string } => Boolean(option));

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (settingOptions.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(COMPANION_SETTINGS_ID)
          .setPlaceholder("Channel settings")
          .addOptions(settingOptions),
      ),
    );
  }
  if (accessOptions.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(COMPANION_ACCESS_ID)
          .setPlaceholder("Channel permissions")
          .addOptions(accessOptions),
      ),
    );
  }
  return rows;
}

export function companionInterfaceEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Temporary channel controls")
    .setDescription("Use the menus below to manage this room. You can also use `/companion` commands.")
    .setColor(0x5662f5);
}

export async function postCompanionInterface(
  channel: VoiceChannel | VoiceBasedChannel,
  config: CompanionChannelsConfig,
): Promise<string> {
  if (!("send" in channel)) return "";
  const components = buildCompanionInterface(config);
  if (!components.length) return "";
  const message = await channel.send({
    embeds: [companionInterfaceEmbed()],
    components,
  });
  return message.id;
}

export async function ensureCompanionInterface(
  channel: VoiceChannel | VoiceBasedChannel,
  messageId: string,
  config: CompanionChannelsConfig,
): Promise<string> {
  if (!featureEnabled(config, "interface") || !("messages" in channel)) return messageId;
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) return existing.id;
  }
  return postCompanionInterface(channel, config);
}
