import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";
import type { CompanionChannelsConfig } from "../../../config/schemas/companion.js";
import { baseEmbed, type ResultContainer } from "../../../core/embeds.js";
import { containerReply } from "../../../core/responses.js";
import type { Translator } from "../../../i18n/index.js";
import { featureEnabled } from "./config.js";

export const COMPANION_SETTINGS_ID = "companion:settings";
export const COMPANION_ACCESS_ID = "companion:access";
export const COMPANION_PICK_PREFIX = "companion:pick:";
export const COMPANION_MODAL_PREFIX = "companion:modal:";
export const COMPANION_REGION_ID = "companion:region";

export function buildCompanionInterface(config: CompanionChannelsConfig, t: Translator) {
  const settingOptions = [
    featureEnabled(config, "name")
      ? {
          label: t("companion_channels.panel.setting.name.label", "Name"),
          value: "name",
          description: t("companion_channels.panel.setting.name.description", "Rename this room"),
        }
      : null,
    featureEnabled(config, "limit")
      ? {
          label: t("companion_channels.panel.setting.limit.label", "User limit"),
          value: "limit",
          description: t("companion_channels.panel.setting.limit.description", "Cap how many people can join"),
        }
      : null,
    featureEnabled(config, "bitrate")
      ? {
          label: t("companion_channels.panel.setting.bitrate.label", "Bitrate"),
          value: "bitrate",
          description: t("companion_channels.panel.setting.bitrate.description", "Change audio quality"),
        }
      : null,
    featureEnabled(config, "status")
      ? {
          label: t("companion_channels.panel.setting.status.label", "Status"),
          value: "status",
          description: t("companion_channels.panel.setting.status.description", "Set the voice channel status"),
        }
      : null,
    featureEnabled(config, "region")
      ? {
          label: t("companion_channels.panel.setting.region.label", "Region"),
          value: "region",
          description: t("companion_channels.panel.setting.region.description", "Change the voice region"),
        }
      : null,
    featureEnabled(config, "nsfw")
      ? {
          label: t("companion_channels.panel.setting.nsfw.label", "Toggle NSFW"),
          value: "nsfw",
          description: t("companion_channels.panel.setting.nsfw.description", "Mark as NSFW"),
        }
      : null,
    featureEnabled(config, "text")
      ? {
          label: t("companion_channels.panel.setting.text.label", "Text channel"),
          value: "text",
          description: t(
            "companion_channels.panel.setting.text.description",
            "Create or remove a linked text channel",
          ),
        }
      : null,
    featureEnabled(config, "lfm")
      ? {
          label: t("companion_channels.panel.setting.lfm.label", "Looking for members"),
          value: "lfm",
          description: t("companion_channels.panel.setting.lfm.description", "Post in the LFM channel"),
        }
      : null,
  ].filter((option): option is { label: string; value: string; description: string } => Boolean(option));

  const accessOptions = [
    featureEnabled(config, "lock")
      ? {
          label: t("companion_channels.panel.access.lock.label", "Lock"),
          value: "lock",
          description: t("companion_channels.panel.access.lock.description", "Block new joins"),
        }
      : null,
    featureEnabled(config, "lock")
      ? {
          label: t("companion_channels.panel.access.unlock.label", "Unlock"),
          value: "unlock",
          description: t("companion_channels.panel.access.unlock.description", "Allow new joins"),
        }
      : null,
    featureEnabled(config, "ghost")
      ? {
          label: t("companion_channels.panel.access.ghost.label", "Ghost"),
          value: "ghost",
          description: t("companion_channels.panel.access.ghost.description", "Hide from the channel list"),
        }
      : null,
    featureEnabled(config, "ghost")
      ? {
          label: t("companion_channels.panel.access.unghost.label", "Unghost"),
          value: "unghost",
          description: t("companion_channels.panel.access.unghost.description", "Show in the channel list"),
        }
      : null,
    featureEnabled(config, "permit")
      ? {
          label: t("companion_channels.panel.access.permit.label", "Permit"),
          value: "permit",
          description: t("companion_channels.panel.access.permit.description", "Allow a user or role in"),
        }
      : null,
    featureEnabled(config, "reject")
      ? {
          label: t("companion_channels.panel.access.reject.label", "Reject"),
          value: "reject",
          description: t("companion_channels.panel.access.reject.description", "Block and kick a user or role"),
        }
      : null,
    featureEnabled(config, "transfer")
      ? {
          label: t("companion_channels.panel.access.transfer.label", "Transfer"),
          value: "transfer",
          description: t(
            "companion_channels.panel.access.transfer.description",
            "Give ownership to someone else",
          ),
        }
      : null,
    featureEnabled(config, "claim")
      ? {
          label: t("companion_channels.panel.access.claim.label", "Claim"),
          value: "claim",
          description: t(
            "companion_channels.panel.access.claim.description",
            "Take ownership if the owner left",
          ),
        }
      : null,
  ].filter((option): option is { label: string; value: string; description: string } => Boolean(option));

  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (settingOptions.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(COMPANION_SETTINGS_ID)
          .setPlaceholder(t("companion_channels.panel.settingsPlaceholder", "Channel settings"))
          .addOptions(settingOptions),
      ),
    );
  }
  if (accessOptions.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(COMPANION_ACCESS_ID)
          .setPlaceholder(t("companion_channels.panel.accessPlaceholder", "Channel permissions"))
          .addOptions(accessOptions),
      ),
    );
  }
  return rows;
}

export function companionInterfaceEmbed(t: Translator): ResultContainer {
  return baseEmbed()
    .setTitle(t("companion_channels.panel.title", "Temporary channel controls"))
    .setDescription(
      t(
        "companion_channels.panel.description",
        "Use the menus below to manage this room. You can also use `/companion` commands.",
      ),
    );
}

export async function postCompanionInterface(
  channel: VoiceChannel | VoiceBasedChannel,
  config: CompanionChannelsConfig,
  t: Translator,
): Promise<string> {
  if (!("send" in channel)) return "";
  const rows = buildCompanionInterface(config, t);
  if (!rows.length) return "";
  const message = await channel.send(containerReply(companionInterfaceEmbed(t), false, rows));
  return message.id;
}

export async function ensureCompanionInterface(
  channel: VoiceChannel | VoiceBasedChannel,
  messageId: string,
  config: CompanionChannelsConfig,
  t: Translator,
): Promise<string> {
  if (!featureEnabled(config, "interface") || !("messages" in channel)) return messageId;
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (existing) return existing.id;
  }
  return postCompanionInterface(channel, config, t);
}
