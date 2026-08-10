import type { Message } from "discord.js";
import { loadWelcomeConfig } from "./loadConfig.js";

/** Pending first-message reacts: guildId:userId → expiresAt ms */
const pending = new Map<string, number>();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function prune(): void {
  const now = Date.now();
  for (const [k, expires] of pending) {
    if (expires <= now) pending.delete(k);
  }
}

export function armFirstMessageReact(guildId: string, userId: string): void {
  prune();
  pending.set(key(guildId, userId), Date.now() + TTL_MS);
}

export function clearFirstMessageReact(guildId: string, userId: string): void {
  pending.delete(key(guildId, userId));
}

function parseReactEmoji(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const custom = trimmed.match(/^<(a?):([A-Za-z0-9_]+):(\d{5,20})>$/);
  if (custom) return custom[3]!;
  if (/^\d{5,20}$/.test(trimmed)) return trimmed;
  return trimmed;
}

export async function handleWelcomeFirstMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;
  if (!message.channel.isTextBased()) return;

  const k = key(message.guild.id, message.author.id);
  const expires = pending.get(k);
  if (!expires) return;
  if (expires <= Date.now()) {
    pending.delete(k);
    return;
  }

  const config = await loadWelcomeConfig(message.guild.id);
  if (!config?.first_message_react?.enabled) {
    pending.delete(k);
    return;
  }

  const emoji = parseReactEmoji(config.first_message_react.emoji ?? "");
  if (!emoji) {
    pending.delete(k);
    return;
  }

  pending.delete(k);
  await message.react(emoji).catch(() => null);
}
