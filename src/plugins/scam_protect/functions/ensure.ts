import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type MessageEditOptions,
  type TextChannel,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { zScamProtectConfig, type ScamProtectConfig } from "../../../config/schemas/scamProtect.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { scamProtectDefaultOverrides } from "../defaultOverrides.js";
import {
  channelNameHasObfuscation,
  scamProtectDefaultChannelName,
  scamProtectDefaultChannelNameFullwidth,
} from "../constants.js";
import { buildScamProtectWarningPayload } from "./warning.js";
import { countScamProtectCatches } from "./stats.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

/** Opt-in only: missing/undefined enabled means off. */
export function isScamProtectEnabled(guildConfig: GuildConfig): boolean {
  return guildConfig.plugins.scam_protect?.enabled === true;
}

const ensureLocks = new Map<string, Promise<TextChannel | null>>();

export function getScamProtectConfig(
  guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>,
): ScamProtectConfig {
  return zScamProtectConfig.parse(
    resolvePluginConfig(guildConfig, "scam_protect", scamProtectDefaultOverrides),
  );
}

async function persistChannelIds(
  guildId: string,
  channelId: string,
  warningMessageId: string | undefined,
): Promise<void> {
  await configManager.patchPluginConfig(
    guildId,
    "scam_protect",
    {
      channel_id: channelId,
      ...(warningMessageId ? { warning_message_id: warningMessageId } : {}),
    },
    "system:scam_protect",
  );
}

async function postWarning(channel: TextChannel, existingId?: string): Promise<string | undefined> {
  const caught = await countScamProtectCatches(channel.guild.id);
  const payload = buildScamProtectWarningPayload(caught);

  if (existingId) {
    const existing = await channel.messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit(payload as MessageEditOptions).catch(() => null);
      return existing.id;
    }
  }

  const sent = await channel.send(payload);
  return sent.id;
}

/** Refresh the warning so the Caught button stays up to date. */
export async function refreshScamProtectWarning(guild: Guild): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!isScamProtectEnabled(guildConfig)) return;
  const config = getScamProtectConfig(guildConfig);
  if (!config.channel_id || !config.warning_message_id) return;

  const channel = await guild.channels.fetch(config.channel_id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const message = await channel.messages.fetch(config.warning_message_id).catch(() => null);
  if (!message) return;

  const caught = await countScamProtectCatches(guild.id);
  await message.edit(buildScamProtectWarningPayload(caught) as MessageEditOptions).catch(() => null);
}

/**
 * Renames the channel to `desiredName` if it's drifted. `isDefaultName` gates the
 * lookalike-collapse fallback below — that trick only matters for the auto-generated
 * obfuscated default; an admin's own custom name is used verbatim, no correction applied.
 */
async function applyDesiredName(channel: TextChannel, desiredName: string, isDefaultName: boolean): Promise<TextChannel> {
  if (channel.name !== desiredName) {
    await channel.setName(desiredName).catch(() => null);
  }
  if (!isDefaultName) return channel;

  // If Discord collapsed lookalikes to ASCII, fall back to fullwidth Latin.
  const refreshed =
    (await channel.guild.channels.fetch(channel.id).catch(() => null)) ?? channel;
  if (refreshed.type !== ChannelType.GuildText) return channel;

  if (!channelNameHasObfuscation(refreshed.name)) {
    const fullwidth = scamProtectDefaultChannelNameFullwidth();
    if (refreshed.name !== fullwidth) {
      await refreshed.setName(fullwidth).catch(() => null);
    }
  }

  const finalChannel =
    (await channel.guild.channels.fetch(channel.id).catch(() => null)) ?? refreshed;
  return finalChannel.type === ChannelType.GuildText ? finalChannel : channel;
}

async function createHoneypotChannel(guild: Guild, desiredName: string, isDefaultName: boolean): Promise<TextChannel | null> {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return null;

  const channel = await guild.channels.create({
    name: desiredName,
    type: ChannelType.GuildText,
    reason: "Scam Protect honeypot channel",
    topic: "Do not post here. Messages in this channel trigger an automatic softban.",
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    ],
  });

  const named = await applyDesiredName(channel, desiredName, isDefaultName);
  await named.setPosition(0).catch(() => null);
  return named;
}

async function ensureUnlocked(guild: Guild): Promise<TextChannel | null> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!isScamProtectEnabled(guildConfig)) return null;

  const config = getScamProtectConfig(guildConfig);
  const customName = config.channel_name?.trim();
  const isDefaultName = !customName;
  const desiredName = isDefaultName ? scamProtectDefaultChannelName() : customName!.slice(0, 100);
  let channel: TextChannel | null = null;

  // channel_id is the only source of truth for finding the honeypot again — no name-based
  // recovery fallback, so a custom name can be anything without risking a mismatch. If the id
  // doesn't resolve (never set, or the channel was deleted), a fresh one is just created below.
  if (config.channel_id) {
    const existing = await guild.channels.fetch(config.channel_id).catch(() => null);
    if (existing?.isTextBased() && !existing.isDMBased() && existing.type === ChannelType.GuildText) {
      channel = existing;
    }
  }

  if (!channel) {
    channel = await createHoneypotChannel(guild, desiredName, isDefaultName);
    if (!channel) return null;
  } else {
    channel = await applyDesiredName(channel, desiredName, isDefaultName);
    if (channel.position > 0) {
      await channel.setPosition(0).catch(() => null);
    }
  }

  const warningId = await postWarning(channel, config.warning_message_id);
  if (channel.id !== config.channel_id || warningId !== config.warning_message_id) {
    await persistChannelIds(guild.id, channel.id, warningId);
  }

  return channel;
}

/** Create or repair the obfuscated honeypot channel for a guild. */
export async function ensureScamProtectChannel(guild: Guild): Promise<TextChannel | null> {
  const existing = ensureLocks.get(guild.id);
  if (existing) return existing;

  const pending = ensureUnlocked(guild).finally(() => {
    ensureLocks.delete(guild.id);
  });
  ensureLocks.set(guild.id, pending);
  return pending;
}

/** Ensure honeypot channels for configured guilds where the plugin is enabled. */
export async function ensureScamProtectForClient(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const stored = await configManager.getGuildConfig(guild.id);
    if (!stored) continue;
    if (!isScamProtectEnabled(stored)) continue;
    await ensureScamProtectChannel(guild).catch(() => null);
  }
}
