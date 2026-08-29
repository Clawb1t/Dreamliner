import { ChannelType, type Guild } from "discord.js";
import type { ConfigManager } from "../config/manager.js";
import {
  countScamProtectCatches,
  listScamProtectCatchesByDay,
  type ScamProtectDayCount,
} from "../plugins/scam_protect/functions/stats.js";
import {
  ensureScamProtectChannel,
  getScamProtectConfig,
  isScamProtectEnabled,
} from "../plugins/scam_protect/functions/ensure.js";

export type WebScamProtectStatus = {
  enabled: boolean;
  channelId: string | null;
  /** The channel's actual current name on Discord, once created. */
  channelName: string | null;
  /** The configured custom name (empty means "use the auto-generated default"). */
  configuredChannelName: string;
  warningMessageId: string | null;
  caughtCount: number;
  caughtByDay: ScamProtectDayCount[];
  ready: boolean;
};

export async function buildWebScamProtectStatus(
  guild: Guild,
  configManager: ConfigManager,
): Promise<WebScamProtectStatus> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const enabled = isScamProtectEnabled(guildConfig);
  const config = getScamProtectConfig(guildConfig);
  const channelId = config.channel_id?.trim() || null;
  let channelName: string | null = null;
  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) channelName = channel.name;
  }
  const [caughtCount, caughtByDay] = await Promise.all([
    countScamProtectCatches(guild.id),
    listScamProtectCatchesByDay(guild.id, 30),
  ]);
  return {
    enabled,
    channelId,
    channelName,
    configuredChannelName: config.channel_name ?? "",
    warningMessageId: config.warning_message_id?.trim() || null,
    caughtCount,
    caughtByDay,
    ready: Boolean(enabled && channelId && channelName),
  };
}

export async function setupWebScamProtect(
  guild: Guild,
  configManager: ConfigManager,
  userId: string,
  channelName?: string,
): Promise<{ ok: true; status: WebScamProtectStatus } | { ok: false; error: string }> {
  const name = typeof channelName === "string" ? channelName.trim().slice(0, 100) : undefined;

  if (name !== undefined) {
    const patch = await configManager.patchPluginConfig(
      guild.id,
      "scam_protect",
      { channel_name: name },
      userId,
    );
    if (!patch.success) {
      return { ok: false, error: patch.errors.join("; ") || "Failed to save channel name." };
    }
  }

  const enabled = await configManager.setPluginEnabled(guild.id, "scam_protect", true, userId);
  if (!enabled.success) {
    return { ok: false, error: enabled.errors.join("; ") || "Failed to enable Scam Protect." };
  }

  const channel = await ensureScamProtectChannel(guild);
  if (!channel) {
    return {
      ok: false,
      error: "Could not create the honeypot channel. Check Manage Channels and Ban Members.",
    };
  }

  const status = await buildWebScamProtectStatus(guild, configManager);
  return { ok: true, status };
}

export async function disableWebScamProtect(
  guild: Guild,
  configManager: ConfigManager,
  userId: string,
): Promise<{ ok: true; status: WebScamProtectStatus } | { ok: false; error: string }> {
  // Read channel id before disable so ChannelDelete does not recreate it.
  const before = await configManager.getEffectiveConfig(guild.id);
  const channelId = getScamProtectConfig(before).channel_id?.trim() || null;

  const result = await configManager.setPluginEnabled(guild.id, "scam_protect", false, userId);
  if (!result.success) {
    return { ok: false, error: result.errors.join("; ") || "Failed to disable Scam Protect." };
  }

  if (channelId) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await channel.delete("Scam Protect disabled").catch(() => null);
    }
  }

  await configManager.patchPluginConfig(
    guild.id,
    "scam_protect",
    { channel_id: null, warning_message_id: null },
    userId,
  );

  const status = await buildWebScamProtectStatus(guild, configManager);
  return { ok: true, status };
}
