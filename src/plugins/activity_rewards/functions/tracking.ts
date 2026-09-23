import type { Client, GuildMember, Message, VoiceState } from "discord.js";
import type { ActivityRewardsConfig } from "../../../config/schemas/activityRewards.js";
import { hasIgnoredRole, isIgnoredChannel, loadActiveActivityRewards } from "./config.js";
import { processMember } from "./rewards.js";
import { addProgress } from "./store.js";

// ── Messages ─────────────────────────────────────────────────────────────────

/** guildId:userId → last time a message counted, for message_cooldown_seconds. A restart just
 *  forgets the window, which at worst lets one extra message count. */
const lastCountedAt = new Map<string, number>();

function sweepCooldowns(now: number): void {
  if (lastCountedAt.size < 50_000) return;
  for (const [key, at] of lastCountedAt) if (now - at > 3_600_000) lastCountedAt.delete(key);
}

export async function handleActivityMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;

  const config = await loadActiveActivityRewards(message.guildId);
  if (!config) return;

  const channel = message.channel;
  const parentId = "parentId" in channel ? channel.parentId : null;
  const categoryId = channel.isThread() ? channel.parent?.parentId : null;
  if (isIgnoredChannel(config, message.channelId, parentId, categoryId)) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || hasIgnoredRole(config, member.roles.cache.keys())) return;

  const hasMedia = message.attachments.size > 0 || message.stickers.size > 0;
  if (!hasMedia && message.content.trim().length < config.min_message_length) return;

  const key = `${message.guildId}:${member.id}`;
  const now = Date.now();
  const last = lastCountedAt.get(key);
  if (last !== undefined && now - last < config.message_cooldown_seconds * 1000) return;
  lastCountedAt.set(key, now);
  sweepCooldowns(now);

  const progress = addProgress(message.guildId, member.id, { messages: 1 });
  await processMember(member, config, progress, { activityChannelId: message.channelId });
}

// ── Voice ────────────────────────────────────────────────────────────────────

export const VOICE_TICK_MS = 60_000;
let lastVoiceTick = Date.now();

function voiceStateCounts(state: VoiceState, config: ActivityRewardsConfig, humansInChannel: number): boolean {
  const member = state.member;
  const channel = state.channel;
  if (!member || member.user.bot || !channel) return false;
  if (config.voice_ignore_afk && channel.id === state.guild.afkChannelId) return false;
  if (isIgnoredChannel(config, channel.id, channel.parentId)) return false;
  if (hasIgnoredRole(config, member.roles.cache.keys())) return false;
  if (config.voice_ignore_muted && (state.mute || state.deaf)) return false;
  if (config.voice_require_others && humansInChannel < 2) return false;
  return true;
}

/**
 * Credits voice time to everyone currently in a voice channel who meets the tracking rules.
 * Sampling on a fixed tick (rather than join/leave sessions) keeps every rule (muted, alone,
 * AFK) correct as it changes mid-session, and survives restarts without any session state.
 */
export async function tickActivityVoice(client: Client): Promise<void> {
  const now = Date.now();
  // Cap the credit so a stalled event loop (or the first tick after a long pause) can't dump
  // a large chunk of unobserved time onto whoever happens to be in voice right now.
  const seconds = Math.round(Math.min(now - lastVoiceTick, VOICE_TICK_MS * 2) / 1000);
  lastVoiceTick = now;
  if (seconds <= 0) return;

  for (const guild of client.guilds.cache.values()) {
    if (guild.voiceStates.cache.size === 0) continue;
    const config = await loadActiveActivityRewards(guild.id);
    if (!config) continue;

    const humans = new Map<string, number>();
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId && state.member && !state.member.user.bot) {
        humans.set(state.channelId, (humans.get(state.channelId) ?? 0) + 1);
      }
    }

    const credited: Array<{ member: GuildMember; channelId: string }> = [];
    for (const state of guild.voiceStates.cache.values()) {
      if (!voiceStateCounts(state, config, humans.get(state.channelId ?? "") ?? 0)) continue;
      credited.push({ member: state.member!, channelId: state.channelId! });
    }

    for (const { member, channelId } of credited) {
      const progress = addProgress(guild.id, member.id, { voiceSeconds: seconds });
      await processMember(member, config, progress, { activityChannelId: channelId }).catch(() => null);
    }
  }
}
