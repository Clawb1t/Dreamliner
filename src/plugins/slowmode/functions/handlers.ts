import {
  DiscordAPIError,
  PermissionFlagsBits,
  Routes,
  type GuildMember,
  type Message,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getSlowmodeGuildConfig } from "./config.js";
import { cooldownKey, getActiveSlot, setAnchorSlot, type Slot } from "./cooldown.js";
import { ensureMarker } from "./markers.js";
import { runExclusive } from "./queue.js";
import { resolveIndividualDelay } from "./rules.js";

const guildConfigCache = new Map<
  string,
  { at: number; config: Awaited<ReturnType<typeof configManager.getEffectiveConfig>> }
>();
const CONFIG_TTL_MS = 2_000;

async function getCachedGuildConfig(guildId: string) {
  const hit = guildConfigCache.get(guildId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
  const config = await configManager.getEffectiveConfig(guildId);
  guildConfigCache.set(guildId, { at: Date.now(), config });
  return config;
}

export function invalidateSlowmodeConfigCache(guildId?: string): void {
  if (guildId) guildConfigCache.delete(guildId);
  else guildConfigCache.clear();
}

function isUnknownMessageError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10008;
}

async function forceDeleteMessage(message: Message): Promise<void> {
  try {
    await message.client.rest.delete(Routes.channelMessage(message.channel.id, message.id));
    return;
  } catch (error) {
    if (isUnknownMessageError(error)) return;
  }

  try {
    await message.delete();
  } catch (error) {
    if (!isUnknownMessageError(error)) {
      console.error(`[slowmode] Failed to delete message ${message.id} in ${message.channel.id}:`, error);
    }
  }
}

function hasManageMessagesBypass(member: GuildMember, channelId: string, allowBypass: boolean): boolean {
  if (!allowBypass) return false;
  try {
    return member.permissionsIn(channelId).has(PermissionFlagsBits.ManageMessages);
  } catch {
    return member.permissions.has(PermissionFlagsBits.ManageMessages);
  }
}

async function resolveMember(message: Message): Promise<GuildMember | null> {
  if (!message.guild || !message.author) return null;
  try {
    const member = await message.guild.members.fetch({
      user: message.author.id,
      force: false,
    });
    return member;
  } catch {
    return message.member ?? null;
  }
}

async function handleViolation(message: Message, slot: Slot, userId: string): Promise<void> {
  await forceDeleteMessage(message);
  void ensureMarker({
    client: message.client,
    guildId: message.guild!.id,
    channelId: slot.channelId,
    userId,
    slot,
  });
}

async function enforceSlowmode(message: Message): Promise<void> {
  if (!message.guild || !message.author || message.author.bot) return;
  if (message.webhookId || message.system) return;
  if (!message.channel.isTextBased() || message.channel.isDMBased()) return;

  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const userId = message.author.id;
  const key = cooldownKey(guildId, channelId, userId);
  const now = Date.now();
  const createdAt = message.createdTimestamp || now;

  const active = getActiveSlot(key, now);
  if (active) {
    if (message.id === active.messageId) return;
    await handleViolation(message, active, userId);
    return;
  }

  const guildConfig = await getCachedGuildConfig(guildId);
  if (!pluginEnabled(guildConfig, "slowmode")) return;

  const config = getSlowmodeGuildConfig(guildConfig);
  if (!config.individual_enabled) return;

  const member = await resolveMember(message);
  if (!member) return;

  if (hasManageMessagesBypass(member, channelId, config.allow_manage_messages_bypass)) return;

  const resolved = resolveIndividualDelay(config, member, channelId);
  if (resolved.seconds <= 0) return;

  const activeAfterConfig = getActiveSlot(key, Date.now());
  if (activeAfterConfig) {
    if (message.id === activeAfterConfig.messageId) return;
    await handleViolation(message, activeAfterConfig, userId);
    return;
  }

  setAnchorSlot(guildId, channelId, userId, message.id, createdAt, resolved.seconds);
}

export async function handleSlowmodeMessage(message: Message): Promise<void> {
  try {
    if (!message.guild || !message.author || message.author.bot) return;
    if (message.webhookId || message.system) return;
    if (!message.channel.isTextBased() || message.channel.isDMBased()) return;

    const key = cooldownKey(message.guild.id, message.channel.id, message.author.id);
    await runExclusive(key, () => enforceSlowmode(message));
  } catch (error) {
    console.error("[slowmode] Handler error:", error);
  }
}
