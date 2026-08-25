import type { Client, Guild, GuildMember, Message, TextChannel, VoiceChannel } from "discord.js";
import { ChannelType } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { CounterEntry } from "../../../config/schemas/counters.js";
import { baseEmbed, setEmbedAuthor } from "../../../core/embeds.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { loadCountersConfig, countersByName } from "./config.js";
import {
  deleteCounterRow,
  ensureCounterRow,
  getCounterRow,
  listCounterRows,
  normalizeCounterName,
  pruneCounterRows,
  setCounterLastRenamedAt,
  setCounterMessageId,
  updateCounterValue,
  type CounterRow,
} from "./store.js";

const bumpChains = new Map<string, Promise<unknown>>();

function counterKey(guildId: string, name: string): string {
  return `${guildId}:${normalizeCounterName(name)}`;
}

function runExclusive(key: string, task: () => Promise<void>): Promise<void> {
  const previous = bumpChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  bumpChains.set(key, settled);
  void settled.then(() => {
    if (bumpChains.get(key) === settled) bumpChains.delete(key);
  });
  return current;
}

export function formatCounterText(entry: CounterEntry, value: number): string {
  const text = (entry.format || "{value}").replaceAll("{value}", value.toLocaleString());
  return text.slice(0, 100);
}

function buildCounterEmbed(entry: CounterEntry, value: number, client: Client) {
  return setEmbedAuthor(baseEmbed(), entry.name || "Counter", client, { tone: "neutral" })
    .setDescription(`**${formatCounterText(entry, value)}**`)
    .setFooter({ text: entry.metric === "custom" ? "Custom counter" : "Updates automatically" })
    .toJSON();
}

export function formatCounterMessage(entry: CounterEntry, value: number, client: Client) {
  return { embeds: [buildCounterEmbed(entry, value, client)] };
}

async function applyMessageDisplay(
  guild: Guild,
  entry: CounterEntry,
  row: CounterRow | null,
  value: number,
): Promise<void> {
  const channel = await guild.channels.fetch(entry.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return;
  const textChannel = channel as TextChannel;

  if (row?.messageId) {
    const existing = await textChannel.messages.fetch(row.messageId).catch(() => null);
    if (existing) {
      await existing.edit(formatCounterMessage(entry, value, guild.client)).catch(() => null);
      return;
    }
  }

  const sent = await textChannel.send(formatCounterMessage(entry, value, guild.client)).catch(() => null);
  if (sent) await setCounterMessageId(guild.id, entry.name, sent.id);
}

/** Discord allows at most 2 channel renames per 10 minutes — refresh_minutes (min 5)
 * keeps every counter well under that even if several share a channel. */
async function applyChannelNameDisplay(
  guild: Guild,
  entry: CounterEntry,
  row: CounterRow | null,
  value: number,
  wantVoice: boolean,
): Promise<void> {
  const now = Date.now();
  const dueAt = (row?.lastRenamedAt ?? 0) + entry.refresh_minutes * 60_000;
  if (row && now < dueAt) return;

  const channel = await guild.channels.fetch(entry.channel_id).catch(() => null);
  if (!channel) return;
  const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
  if (wantVoice !== isVoice) return;

  const nextName = formatCounterText(entry, value);
  if (channel.name === nextName) {
    // Nothing to rename, but still record the check so the sweep doesn't
    // re-fetch this channel every minute.
    await setCounterLastRenamedAt(guild.id, entry.name, now);
    return;
  }

  const target = channel as TextChannel | VoiceChannel;
  const renamed = await target.setName(nextName).catch(() => null);
  if (renamed) await setCounterLastRenamedAt(guild.id, entry.name, now);
}

export async function applyCounterDisplay(
  guild: Guild,
  entry: CounterEntry,
  row: CounterRow | null,
  value: number,
): Promise<void> {
  if (entry.display === "message") {
    await applyMessageDisplay(guild, entry, row, value);
  } else if (entry.display === "channel_name") {
    await applyChannelNameDisplay(guild, entry, row, value, false);
  } else {
    await applyChannelNameDisplay(guild, entry, row, value, true);
  }
}

async function syncCounterValue(guild: Guild, entry: CounterEntry, value: number): Promise<void> {
  await updateCounterValue(guild.id, entry.name, value);
  const row = await getCounterRow(guild.id, entry.name);
  await applyCounterDisplay(guild, entry, row, value);
}

export async function handleCounterMemberChange(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!pluginEnabled(guildConfig, "counters")) return;

  const entries = [...countersByName(loadCountersConfig(guildConfig)).values()].filter(
    (e) => e.metric === "members",
  );
  if (entries.length === 0) return;

  await member.guild.members.fetch().catch(() => null);
  const count = member.guild.memberCount;

  for (const entry of entries) {
    await runExclusive(counterKey(member.guild.id, entry.name), () =>
      syncCounterValue(member.guild, entry, count),
    );
  }
}

export async function handleCounterMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "counters")) return;

  const entries = [...countersByName(loadCountersConfig(guildConfig)).values()].filter(
    (e) => e.metric === "messages",
  );

  for (const entry of entries) {
    await runExclusive(counterKey(message.guild.id, entry.name), async () => {
      const row = await getCounterRow(message.guild!.id, entry.name);
      const next = (row?.value ?? 0) + 1;
      await syncCounterValue(message.guild!, entry, next);
    });
  }
}

export async function handleCounterGuildUpdate(oldGuild: Guild, newGuild: Guild): Promise<void> {
  if (oldGuild.premiumSubscriptionCount === newGuild.premiumSubscriptionCount) return;

  const guildConfig = await configManager.getEffectiveConfig(newGuild.id);
  if (!pluginEnabled(guildConfig, "counters")) return;

  const entries = [...countersByName(loadCountersConfig(guildConfig)).values()].filter(
    (e) => e.metric === "boosts",
  );
  const count = newGuild.premiumSubscriptionCount ?? 0;

  for (const entry of entries) {
    await runExclusive(counterKey(newGuild.id, entry.name), () => syncCounterValue(newGuild, entry, count));
  }
}

function initialValueFor(entry: CounterEntry, guild: Guild): number {
  if (entry.metric === "members") return guild.memberCount;
  if (entry.metric === "boosts") return guild.premiumSubscriptionCount ?? 0;
  return Math.max(0, entry.value ?? 0);
}

/** Reconcile DB-tracked counter rows against the current config: create rows for
 * new counters, drop rows for ones removed/disabled/renamed, and push through
 * any value the dashboard just changed (custom counters, format edits, etc). */
export async function syncGuildCounters(
  client: Client,
  guildId: string,
  options?: { guildConfig?: GuildConfig },
): Promise<void> {
  const guildConfig = options?.guildConfig ?? (await configManager.getEffectiveConfig(guildId));

  if (!pluginEnabled(guildConfig, "counters")) {
    const stale = await pruneCounterRows(guildId, []);
    if (stale.length === 0) return;
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (guild) await cleanupStaleRows(guild, stale);
    return;
  }

  const entries = countersByName(loadCountersConfig(guildConfig));
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const stale = await pruneCounterRows(guildId, [...entries.keys()]);
  if (stale.length > 0) await cleanupStaleRows(guild, stale);

  for (const entry of entries.values()) {
    await runExclusive(counterKey(guildId, entry.name), async () => {
      let row = await getCounterRow(guildId, entry.name);
      if (!row) {
        const value = initialValueFor(entry, guild);
        await ensureCounterRow({ guildId, name: entry.name, channelId: entry.channel_id, value });
        row = await getCounterRow(guildId, entry.name);
      } else if (entry.metric === "custom" && row.value !== entry.value) {
        await updateCounterValue(guildId, entry.name, entry.value);
        row = await getCounterRow(guildId, entry.name);
      }
      if (!row) return;
      await applyCounterDisplay(guild, entry, row, row.value);
    });
  }
}

async function cleanupStaleRows(guild: Guild, stale: CounterRow[]): Promise<void> {
  for (const row of stale) {
    if (!row.messageId) continue;
    const channel = await guild.channels.fetch(row.channelId).catch(() => null);
    if (channel?.isTextBased() && "messages" in channel) {
      const message = await channel.messages.fetch(row.messageId).catch(() => null);
      await message?.delete().catch(() => null);
    }
  }
}

export async function handleCounterReady(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await syncGuildCounters(client, guild.id).catch((error) => {
      console.error(`[counters] Failed to sync counters for ${guild.id}:`, error);
    });
  }
}

/** Periodic sweep for channel_name/voice_name counters — applyChannelNameDisplay
 * already no-ops until each counter's refresh_minutes has elapsed, so calling
 * this on a short interval (e.g. every minute) just lets each counter's own
 * cadence take effect promptly without renaming on every tick. */
export async function runCounterRefreshSweep(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
    if (!guildConfig || !pluginEnabled(guildConfig, "counters")) continue;

    const entries = [...countersByName(loadCountersConfig(guildConfig)).values()].filter(
      (e) => e.display !== "message",
    );
    if (entries.length === 0) continue;

    for (const entry of entries) {
      await runExclusive(counterKey(guild.id, entry.name), async () => {
        const row = await getCounterRow(guild.id, entry.name);
        if (!row) return;
        await applyCounterDisplay(guild, entry, row, row.value);
      });
    }
  }
}

export { deleteCounterRow, listCounterRows };
