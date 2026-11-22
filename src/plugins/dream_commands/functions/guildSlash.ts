import { ChannelType, InteractionContextType, Routes, SlashCommandBuilder, type Client } from "discord.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { listEnabledDreamCommands, type DreamCommandRow } from "./store.js";
import { getLogger } from "../../../core/logger.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { isDreamlinerOneActive } from "../../../bridge/dreamlinerOne.js";
import { capMap } from "../../../core/mapPrune.js";
import { LIMITS, type CommandOption } from "../engine/types.js";
import { visibilityBits } from "../engine/permissions.js";
const log = getLogger("dream_commands");

/**
 * Dreamliner registers no other guild-scoped commands (every built-in command is global, and
 * global and guild commands have separate 100-command limits), so the whole guild allowance is
 * available to custom commands.
 */
export const OTHER_GUILD_COMMANDS = 0;

const ONE_CACHE_MS = 5 * 60_000;
const oneCache = new Map<string, { active: boolean; at: number }>();

export async function guildHasOne(guildId: string): Promise<boolean> {
  const cached = oneCache.get(guildId);
  if (cached && Date.now() - cached.at < ONE_CACHE_MS) return cached.active;
  const active = await isDreamlinerOneActive(guildId).catch(() => false);
  oneCache.set(guildId, { active, at: Date.now() });
  capMap(oneCache, 5000);
  return active;
}

/** Commands a server may have: 25 free, 100 with Dreamliner One, never more than Discord allows. */
export function commandCap(oneActive: boolean): number {
  const product = oneActive ? LIMITS.oneCommands : LIMITS.freeCommands;
  return Math.min(product, LIMITS.discordGuildCommands - OTHER_GUILD_COMMANDS);
}

const reservedNamesCache = new Set<string>();
const syncedPluginState = new Map<string, boolean>();
/** Names registered in Discord at the last sync, per guild (for the dashboard's "registered" flag). */
const registeredNames = new Map<string, Set<string>>();

export function dreamCommandsNeedResync(guildId: string, enabled: boolean): boolean {
  return syncedPluginState.get(guildId) !== enabled;
}

export function isRegistered(guildId: string, name: string): boolean {
  return registeredNames.get(guildId)?.has(name) ?? false;
}

/** Built-in Dreamliner slash command names (and a few fixed reserves). */
export function getReservedCommandNames(): Set<string> {
  if (reservedNamesCache.size === 0) {
    for (const cmd of getAllSlashCommands()) reservedNamesCache.add(cmd.data.name);
    reservedNamesCache.add("command");
    reservedNamesCache.add("help");
  }
  return reservedNamesCache;
}

export function isReservedCommandName(name: string): boolean {
  return getReservedCommandNames().has(name.trim().toLowerCase());
}

const CHANNEL_TYPES: Record<string, ChannelType[]> = {
  text: [ChannelType.GuildText],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory],
  announcement: [ChannelType.GuildAnnouncement],
  forum: [ChannelType.GuildForum],
  stage: [ChannelType.GuildStageVoice],
  thread: [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread],
};

function addOption(builder: SlashCommandBuilder, o: CommandOption): void {
  const desc = (o.description || o.name).slice(0, 100);
  switch (o.type) {
    case "text":
      builder.addStringOption((opt) => {
        opt.setName(o.name).setDescription(desc).setRequired(o.required);
        if (o.minLength != null) opt.setMinLength(Math.min(6000, o.minLength));
        if (o.maxLength != null) opt.setMaxLength(Math.min(6000, Math.max(1, o.maxLength)));
        if (o.choices?.length) opt.addChoices(...o.choices.slice(0, 25).map((c) => ({ name: c.name, value: c.value })));
        else if (o.autocomplete?.length) opt.setAutocomplete(true);
        return opt;
      });
      break;
    case "integer":
    case "number": {
      const configure = <T extends { setName(n: string): T; setDescription(d: string): T; setRequired(r: boolean): T; setMinValue(n: number): T; setMaxValue(n: number): T; addChoices(...c: { name: string; value: number }[]): T }>(opt: T): T => {
        opt.setName(o.name).setDescription(desc).setRequired(o.required);
        if (o.min != null) opt.setMinValue(o.min);
        if (o.max != null) opt.setMaxValue(o.max);
        if (o.choices?.length) opt.addChoices(...o.choices.slice(0, 25).map((c) => ({ name: c.name, value: Number(c.value) })));
        return opt;
      };
      if (o.type === "integer") builder.addIntegerOption((opt) => configure(opt));
      else builder.addNumberOption((opt) => configure(opt));
      break;
    }
    case "boolean":
      builder.addBooleanOption((opt) => opt.setName(o.name).setDescription(desc).setRequired(o.required));
      break;
    case "user":
    case "member":
      builder.addUserOption((opt) => opt.setName(o.name).setDescription(desc).setRequired(o.required));
      break;
    case "role":
      builder.addRoleOption((opt) => opt.setName(o.name).setDescription(desc).setRequired(o.required));
      break;
    case "channel":
      builder.addChannelOption((opt) => {
        opt.setName(o.name).setDescription(desc).setRequired(o.required);
        const types = (o.channelTypes ?? []).flatMap((t) => CHANNEL_TYPES[t] ?? []);
        if (types.length) opt.addChannelTypes(...(types as Parameters<typeof opt.addChannelTypes>));
        return opt;
      });
      break;
    case "attachment":
      builder.addAttachmentOption((opt) => opt.setName(o.name).setDescription(desc).setRequired(o.required));
      break;
  }
}

export function buildCommandJson(row: DreamCommandRow) {
  const builder = new SlashCommandBuilder()
    .setName(row.name)
    .setDescription((row.program.description?.trim() || `Custom command: /${row.name}`).slice(0, 100))
    .setContexts(InteractionContextType.Guild);
  const bits = visibilityBits(row.program);
  if (bits) builder.setDefaultMemberPermissions(bits);
  for (const option of row.program.options.slice(0, LIMITS.options)) addOption(builder, option);
  return builder.toJSON();
}

/** The commands that fit under the cap, oldest first (the rest show "over the limit"). */
export function selectRegistrable(rows: DreamCommandRow[], cap: number): DreamCommandRow[] {
  return rows.filter((row) => !isReservedCommandName(row.name)).slice(0, cap);
}

export async function syncGuildDreamSlashCommands(client: Client, guildId: string): Promise<number> {
  const clientId = client.application?.id ?? client.user?.id;
  if (!clientId || !client.token) {
    log.warn(`[dream_commands] Cannot sync guild slash commands for ${guildId}: client not ready`);
    return 0;
  }
  const enabled = pluginEnabled(await configManager.getEffectiveConfig(guildId), "dream_commands");
  const rows = enabled ? await listEnabledDreamCommands(guildId) : [];
  const cap = commandCap(await guildHasOne(guildId));
  const chosen = selectRegistrable(rows, cap);
  const body: unknown[] = [];
  for (const row of chosen) {
    try {
      body.push(buildCommandJson(row));
    } catch (error) {
      log.warn(`[dream_commands] /${row.name} in ${guildId} couldn't be built for Discord:`, error);
    }
  }
  // One PUT replaces the guild's whole command list.
  await client.rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  syncedPluginState.set(guildId, enabled);
  registeredNames.set(guildId, new Set(chosen.map((r) => r.name)));
  return body.length;
}

// ── Debounced sync: many saves in a row become one PUT ─────────────────────────────────────

const pending = new Map<string, { timer: NodeJS.Timeout; waiters: Array<{ resolve: (n: number) => void; reject: (e: unknown) => void }> }>();
const SYNC_DEBOUNCE_MS = 1200;

export function scheduleGuildSync(client: Client, guildId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const existing = pending.get(guildId);
    if (existing) clearTimeout(existing.timer);
    const waiters = existing?.waiters ?? [];
    waiters.push({ resolve, reject });
    const timer = setTimeout(() => {
      pending.delete(guildId);
      syncGuildDreamSlashCommands(client, guildId).then(
        (n) => waiters.forEach((w) => w.resolve(n)),
        (e) => waiters.forEach((w) => w.reject(e)),
      );
    }, SYNC_DEBOUNCE_MS);
    pending.set(guildId, { timer, waiters });
  });
}

export async function syncAllGuildDreamSlashCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await syncGuildDreamSlashCommands(client, guild.id);
    } catch (error) {
      log.error(`[dream_commands] Failed to sync guild commands for ${guild.id}:`, error);
    }
  }
}
