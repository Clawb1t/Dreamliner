import {
  ActionRowBuilder,
  type ButtonBuilder,
  type Client,
  type EmbedBuilder,
  type Guild,
  type TextChannel,
} from "discord.js";
import { configManager } from "../config/manager.js";
import { zGiveawaysConfig, type GiveawaysConfig } from "../config/schemas/giveaways.js";
import { zPersistEmbedConfig, type PersistEmbedConfig } from "../config/schemas/persist.js";
import { getPluginSettings } from "../core/permissionRoles.js";
import { emitLog } from "../core/logging/send.js";
import * as store from "../plugins/giveaways/functions/store.js";
import type {
  BonusRoleWeight,
  Giveaway,
  GiveawayButtonStyle,
  GiveawayEntryMethod,
  GiveawayRequireRoleMode,
  GiveawayStatus,
  GiveawayTemplate,
} from "../plugins/giveaways/functions/store.js";
import { rerollWinner } from "../plugins/giveaways/functions/draw.js";
import { finishGiveaway, startGiveaway } from "../plugins/giveaways/functions/scheduler.js";
import {
  buildClaimComponents,
  buildGiveawayCancelledEmbed,
  buildGiveawayComponents,
  buildGiveawayEmbed,
  buildGiveawayEndedEmbed,
} from "../plugins/giveaways/functions/embeds.js";

export type WebGiveaway = {
  id: number;
  title: string;
  prize: string;
  status: GiveawayStatus;
  channelId: string;
  messageId: string | null;
  entryMethod: GiveawayEntryMethod;
  reactionEmoji: string;
  buttonLabel: string;
  buttonEmoji: string;
  buttonStyle: GiveawayButtonStyle;
  embed: PersistEmbedConfig;
  winnerCount: number;
  requireRoleIds: string[];
  requireRoleMode: GiveawayRequireRoleMode;
  blacklistRoleIds: string[];
  bypassRoleIds: string[];
  minAccountAgeDays: number;
  minJoinAgeDays: number;
  bonusRoleWeights: BonusRoleWeight[];
  boosterBonusWeight: number;
  entryCost: number;
  winBonus: number;
  pingRoleId: string | null;
  dmWinner: boolean;
  dmNonWinners: boolean;
  claimWindowMinutes: number;
  startsAt: string;
  endsAt: string;
  pausedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  entryCount: number;
  winners: {
    id: number;
    userId: string;
    status: store.WinnerStatus;
    selectedAt: string;
    claimedAt: string | null;
  }[];
};

export type WebGiveawayTemplate = {
  id: number;
  name: string;
  settings: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
};

/** Dashboard-authored draft: everything optional except the three fields the create form can't
 *  sensibly default. Every other field is resolved against `zGiveawaysConfig`'s guild-wide
 *  defaults by `createGuildGiveaway`. `endsAt` (absolute) or `durationMinutes` (relative to
 *  `startsAt`, or now) must resolve to an end after the start. */
export type CreateGiveawayInput = {
  channelId: string;
  title: string;
  prize: string;
  entryMethod?: GiveawayEntryMethod;
  reactionEmoji?: string;
  buttonLabel?: string;
  buttonEmoji?: string;
  buttonStyle?: GiveawayButtonStyle;
  embed?: PersistEmbedConfig;
  winnerCount?: number;
  requireRoleIds?: string[];
  requireRoleMode?: GiveawayRequireRoleMode;
  blacklistRoleIds?: string[];
  bypassRoleIds?: string[];
  minAccountAgeDays?: number;
  minJoinAgeDays?: number;
  bonusRoleWeights?: BonusRoleWeight[];
  boosterBonusWeight?: number;
  entryCost?: number;
  winBonus?: number;
  pingRoleId?: string | null;
  dmWinner?: boolean;
  dmNonWinners?: boolean;
  claimWindowMinutes?: number;
  startsAt?: string;
  endsAt?: string;
  durationMinutes?: number;
};

const GIVEAWAY_STATUSES: GiveawayStatus[] = ["scheduled", "active", "ending", "ended", "cancelled", "paused"];
const GIVEAWAY_BUTTON_STYLES: GiveawayButtonStyle[] = ["primary", "secondary", "success", "danger"];

function isGiveawayStatus(value: string | undefined | null): value is GiveawayStatus {
  return Boolean(value) && (GIVEAWAY_STATUSES as string[]).includes(value as string);
}

function isButtonStyle(value: unknown): value is GiveawayButtonStyle {
  return typeof value === "string" && (GIVEAWAY_BUTTON_STYLES as string[]).includes(value);
}

function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function toWebGiveaway(giveaway: Giveaway): Promise<WebGiveaway> {
  const [entryCount, winners] = await Promise.all([
    store.getEntryCount(giveaway.id),
    store.listWinners(giveaway.id),
  ]);

  return {
    id: giveaway.id,
    title: giveaway.title,
    prize: giveaway.prize,
    status: giveaway.status,
    channelId: giveaway.channelId,
    messageId: giveaway.messageId,
    entryMethod: giveaway.entryMethod,
    reactionEmoji: giveaway.reactionEmoji,
    buttonLabel: giveaway.buttonLabel,
    buttonEmoji: giveaway.buttonEmoji,
    buttonStyle: giveaway.buttonStyle,
    embed: giveaway.embedConfig,
    winnerCount: giveaway.winnerCount,
    requireRoleIds: giveaway.requireRoleIds,
    requireRoleMode: giveaway.requireRoleMode,
    blacklistRoleIds: giveaway.blacklistRoleIds,
    bypassRoleIds: giveaway.bypassRoleIds,
    minAccountAgeDays: giveaway.minAccountAgeDays,
    minJoinAgeDays: giveaway.minJoinAgeDays,
    bonusRoleWeights: giveaway.bonusRoleWeights,
    boosterBonusWeight: giveaway.boosterBonusWeight,
    entryCost: giveaway.entryCost,
    winBonus: giveaway.winBonus,
    pingRoleId: giveaway.pingRoleId,
    dmWinner: giveaway.dmWinner,
    dmNonWinners: giveaway.dmNonWinners,
    claimWindowMinutes: giveaway.claimWindowMinutes,
    startsAt: toIso(giveaway.startsAt) ?? new Date(0).toISOString(),
    endsAt: toIso(giveaway.endsAt) ?? new Date(0).toISOString(),
    pausedAt: toIso(giveaway.pausedAt),
    createdBy: giveaway.createdBy,
    createdAt: toIso(giveaway.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(giveaway.updatedAt) ?? new Date(0).toISOString(),
    endedAt: toIso(giveaway.endedAt),
    entryCount,
    winners: winners.map((w) => ({
      id: w.id,
      userId: w.userId,
      status: w.status,
      selectedAt: toIso(w.selectedAt) ?? new Date(0).toISOString(),
      claimedAt: toIso(w.claimedAt),
    })),
  };
}

function toWebTemplate(template: GiveawayTemplate): WebGiveawayTemplate {
  return {
    id: template.id,
    name: template.name,
    settings: template.settings,
    createdBy: template.createdBy,
    createdAt: toIso(template.createdAt) ?? new Date(0).toISOString(),
  };
}

// -- Permission gate -------------------------------------------------------------------------

async function getGiveawaysConfig(guildId: string): Promise<GiveawaysConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return zGiveawaysConfig.parse(getPluginSettings(guildConfig, "giveaways"));
}

// -- Message helpers ---------------------------------------------------------------------------

async function fetchSendableChannel(guild: Guild, channelId: string): Promise<TextChannel | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  return channel as TextChannel;
}

async function editLiveMessage(
  guild: Guild,
  giveaway: Giveaway,
  embed: EmbedBuilder,
  components: ActionRowBuilder<ButtonBuilder>[],
): Promise<void> {
  if (!giveaway.messageId) return;
  const channel = await fetchSendableChannel(guild, giveaway.channelId);
  if (!channel) return;
  await channel.messages
    .fetch(giveaway.messageId)
    .then((message) => message.edit({ embeds: [embed], components }))
    .catch(() => null);
}

/** Refreshes the live embed/components for an active/scheduled/paused giveaway, used after any
 *  edit that changes what the posted message should show. */
async function refreshGiveawayMessage(guild: Guild, giveaway: Giveaway): Promise<void> {
  const entryCount = await store.getEntryCount(giveaway.id);
  await editLiveMessage(guild, giveaway, buildGiveawayEmbed(giveaway, entryCount, guild), buildGiveawayComponents(giveaway, entryCount));
}

async function dmUsers(client: Client, userIds: string[], content: string): Promise<void> {
  for (const userId of userIds) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    await user.send(content).catch(() => null);
  }
}

// -- Reads ---------------------------------------------------------------------------------------

export async function listGuildGiveaways(guild: Guild, query: { status?: string }): Promise<{ giveaways: WebGiveaway[] }> {
  const status = isGiveawayStatus(query.status) ? query.status : undefined;
  const rows = await store.listGiveaways(guild.id, status ? { status } : undefined);
  const items = await Promise.all(rows.map((row) => toWebGiveaway(row)));
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { giveaways: items };
}

export async function getGuildGiveaway(guild: Guild, id: number): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  const giveaway = await store.getGiveaway(guild.id, id);
  if (!giveaway) return { error: "Giveaway not found" };
  return { giveaway: await toWebGiveaway(giveaway) };
}

// -- Create / update / delete ---------------------------------------------------------------------

export async function createGuildGiveaway(
  guild: Guild,
  actorId: string,
  input: CreateGiveawayInput,
): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  if (!input.channelId?.trim()) return { error: "channelId is required" };
  if (!input.title?.trim()) return { error: "title is required" };
  if (!input.prize?.trim()) return { error: "prize is required" };

  const channel = await fetchSendableChannel(guild, input.channelId);
  if (!channel) return { error: "channelId must be a text channel the bot can post in." };

  const config = await getGiveawaysConfig(guild.id);

  const now = new Date();
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  if (Number.isNaN(startsAt.getTime())) return { error: "Invalid startsAt" };

  let endsAt: Date;
  if (input.endsAt) {
    endsAt = new Date(input.endsAt);
  } else if (input.durationMinutes && input.durationMinutes > 0) {
    endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
  } else {
    return { error: "endsAt or durationMinutes is required" };
  }
  if (Number.isNaN(endsAt.getTime())) return { error: "Invalid endsAt" };
  if (endsAt.getTime() <= startsAt.getTime()) return { error: "endsAt must be after startsAt" };

  if (input.buttonStyle !== undefined && !isButtonStyle(input.buttonStyle)) {
    return { error: "Invalid buttonStyle" };
  }

  const embedConfig = input.embed !== undefined ? zPersistEmbedConfig.parse(input.embed) : config.default_embed;

  const created = await store.createGiveaway({
    guildId: guild.id,
    channelId: input.channelId,
    title: input.title.trim(),
    prize: input.prize.trim(),
    entryMethod: input.entryMethod ?? config.default_entry_method,
    reactionEmoji: input.reactionEmoji ?? config.default_reaction_emoji,
    buttonLabel: input.buttonLabel ?? config.default_button_label,
    buttonEmoji: input.buttonEmoji ?? config.default_button_emoji,
    buttonStyle: input.buttonStyle ?? config.default_button_style,
    embedConfig,
    winnerCount: input.winnerCount ?? config.default_winner_count,
    requireRoleIds: input.requireRoleIds ?? [],
    requireRoleMode: input.requireRoleMode ?? config.default_require_role_mode,
    blacklistRoleIds: input.blacklistRoleIds ?? [],
    bypassRoleIds: input.bypassRoleIds ?? [],
    minAccountAgeDays: input.minAccountAgeDays ?? 0,
    minJoinAgeDays: input.minJoinAgeDays ?? 0,
    bonusRoleWeights: input.bonusRoleWeights ?? [],
    boosterBonusWeight: input.boosterBonusWeight ?? config.default_booster_bonus_weight,
    entryCost: input.entryCost ?? config.default_entry_cost,
    winBonus: input.winBonus ?? config.default_win_bonus,
    pingRoleId: input.pingRoleId !== undefined ? input.pingRoleId : (config.ping_role_id ?? null),
    dmWinner: input.dmWinner ?? config.default_dm_winner,
    dmNonWinners: input.dmNonWinners ?? config.default_dm_non_winners,
    claimWindowMinutes: input.claimWindowMinutes ?? config.default_claim_window_minutes,
    startsAt,
    endsAt,
    createdBy: actorId,
  });

  // "Start now" (startsAt already due) posts immediately. A future startsAt is left "scheduled"
  // and picked up by the poller's processScheduledStarts pass once it comes due.
  if (startsAt.getTime() <= Date.now()) {
    const posted = await startGiveaway(guild, created);
    if (posted) return { giveaway: await toWebGiveaway(posted) };
  }

  return { giveaway: await toWebGiveaway(created) };
}

export async function updateGuildGiveaway(
  guild: Guild,
  id: number,
  patch: Partial<CreateGiveawayInput>,
): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  const existing = await store.getGiveaway(guild.id, id);
  if (!existing) return { error: "Giveaway not found" };

  if (patch.channelId !== undefined && !(await fetchSendableChannel(guild, patch.channelId))) {
    return { error: "channelId must be a text channel the bot can post in." };
  }
  if (patch.buttonStyle !== undefined && !isButtonStyle(patch.buttonStyle)) {
    return { error: "Invalid buttonStyle" };
  }

  let startsAt = existing.startsAt;
  if (patch.startsAt !== undefined) {
    const parsed = new Date(patch.startsAt);
    if (Number.isNaN(parsed.getTime())) return { error: "Invalid startsAt" };
    startsAt = parsed;
  }

  let endsAt = existing.endsAt;
  if (patch.endsAt !== undefined) {
    const parsed = new Date(patch.endsAt);
    if (Number.isNaN(parsed.getTime())) return { error: "Invalid endsAt" };
    endsAt = parsed;
  } else if (patch.durationMinutes !== undefined && patch.durationMinutes > 0) {
    endsAt = new Date(startsAt.getTime() + patch.durationMinutes * 60_000);
  }
  if (endsAt.getTime() <= startsAt.getTime()) return { error: "endsAt must be after startsAt" };

  const updated = await store.updateGiveaway(id, {
    ...(patch.channelId !== undefined ? { channelId: patch.channelId } : {}),
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.prize !== undefined ? { prize: patch.prize.trim() } : {}),
    ...(patch.entryMethod !== undefined ? { entryMethod: patch.entryMethod } : {}),
    ...(patch.reactionEmoji !== undefined ? { reactionEmoji: patch.reactionEmoji } : {}),
    ...(patch.buttonLabel !== undefined ? { buttonLabel: patch.buttonLabel } : {}),
    ...(patch.buttonEmoji !== undefined ? { buttonEmoji: patch.buttonEmoji } : {}),
    ...(patch.buttonStyle !== undefined ? { buttonStyle: patch.buttonStyle } : {}),
    ...(patch.embed !== undefined ? { embedConfig: zPersistEmbedConfig.parse(patch.embed) } : {}),
    ...(patch.winnerCount !== undefined ? { winnerCount: patch.winnerCount } : {}),
    ...(patch.requireRoleIds !== undefined ? { requireRoleIds: patch.requireRoleIds } : {}),
    ...(patch.requireRoleMode !== undefined ? { requireRoleMode: patch.requireRoleMode } : {}),
    ...(patch.blacklistRoleIds !== undefined ? { blacklistRoleIds: patch.blacklistRoleIds } : {}),
    ...(patch.bypassRoleIds !== undefined ? { bypassRoleIds: patch.bypassRoleIds } : {}),
    ...(patch.minAccountAgeDays !== undefined ? { minAccountAgeDays: patch.minAccountAgeDays } : {}),
    ...(patch.minJoinAgeDays !== undefined ? { minJoinAgeDays: patch.minJoinAgeDays } : {}),
    ...(patch.bonusRoleWeights !== undefined ? { bonusRoleWeights: patch.bonusRoleWeights } : {}),
    ...(patch.boosterBonusWeight !== undefined ? { boosterBonusWeight: patch.boosterBonusWeight } : {}),
    ...(patch.entryCost !== undefined ? { entryCost: patch.entryCost } : {}),
    ...(patch.winBonus !== undefined ? { winBonus: patch.winBonus } : {}),
    ...(patch.pingRoleId !== undefined ? { pingRoleId: patch.pingRoleId } : {}),
    ...(patch.dmWinner !== undefined ? { dmWinner: patch.dmWinner } : {}),
    ...(patch.dmNonWinners !== undefined ? { dmNonWinners: patch.dmNonWinners } : {}),
    ...(patch.claimWindowMinutes !== undefined ? { claimWindowMinutes: patch.claimWindowMinutes } : {}),
    ...(patch.startsAt !== undefined ? { startsAt } : {}),
    ...(patch.endsAt !== undefined || patch.durationMinutes !== undefined ? { endsAt } : {}),
  });
  if (!updated) return { error: "Giveaway not found" };

  // Entry requirements/weights only affect future entries: `giveaway_entries.weight` is
  // snapshotted at entry time and never retroactively recalculated (see the plan).
  if (updated.messageId && (updated.status === "active" || updated.status === "scheduled" || updated.status === "paused")) {
    await refreshGiveawayMessage(guild, updated).catch(() => null);
  }

  return { giveaway: await toWebGiveaway(updated) };
}

export async function deleteGuildGiveaway(guild: Guild, id: number): Promise<{ ok: true } | { error: string }> {
  const existing = await store.getGiveaway(guild.id, id);
  if (!existing) return { error: "Giveaway not found" };

  if (existing.messageId) {
    const channel = await fetchSendableChannel(guild, existing.channelId);
    await channel?.messages.delete(existing.messageId).catch(() => null);
  }

  await store.deleteGiveaway(id);
  return { ok: true };
}

// -- Actions ---------------------------------------------------------------------------------

export type GiveawayAction = "end" | "reroll" | "pause" | "resume" | "cancel";

export async function performGiveawayAction(
  guild: Guild,
  id: number,
  action: GiveawayAction,
  body: { winnerId?: string },
): Promise<{ giveaway: WebGiveaway } | { error: string }> {
  const giveaway = await store.getGiveaway(guild.id, id);
  if (!giveaway) return { error: "Giveaway not found" };

  if (action === "end") {
    if (giveaway.status !== "active") return { error: `Cannot end a giveaway that is ${giveaway.status}.` };
    // Same active -> ending guarded transition the 30s poller uses, so a dashboard "End Now"
    // click can never race it into double-ending this giveaway.
    const claimed = await store.claimGiveawayForEnding(giveaway.id);
    if (!claimed) return { error: "This giveaway is already being ended." };
    await finishGiveaway(guild.client, claimed);
  } else if (action === "reroll") {
    if (giveaway.status !== "ended" && giveaway.status !== "active") {
      return { error: `Cannot reroll a giveaway that is ${giveaway.status}.` };
    }
    let winnerRowId: number | null = null;
    if (body.winnerId) {
      const winners = await store.listWinners(giveaway.id);
      const target = winners.find((w) => w.userId === body.winnerId && (w.status === "won" || w.status === "claimed"));
      if (!target) return { error: "That user is not a current winner of this giveaway." };
      winnerRowId = target.id;
    }

    const result = await rerollWinner(giveaway, winnerRowId);
    const refreshed = await store.getGiveaway(guild.id, id);
    if (refreshed) {
      const allWinners = await store.listWinners(refreshed.id);
      const wonWinner = allWinners.find((w) => w.status === "won");
      const claimRowId = refreshed.claimWindowMinutes > 0 && wonWinner ? wonWinner.id : null;
      const currentWinnerIds = allWinners.filter((w) => w.status === "won" || w.status === "claimed").map((w) => w.userId);
      await editLiveMessage(
        guild,
        refreshed,
        buildGiveawayEndedEmbed(refreshed, currentWinnerIds),
        claimRowId !== null ? buildClaimComponents(refreshed.id, claimRowId) : [],
      );

      if (refreshed.dmWinner && result.newWinnerIds.length) {
        await dmUsers(guild.client, result.newWinnerIds, `You won **${refreshed.prize}**! Congratulations.`);
      }

      const guildConfig = await configManager.getEffectiveConfig(guild.id);
      await emitLog(
        guild.client,
        guildConfig,
        {
          title: "Giveaway rerolled",
          information: [
            `**Prize:** ${refreshed.prize}`,
            `**Old winner(s):** ${result.oldWinnerIds.length ? result.oldWinnerIds.map((i) => `<@${i}>`).join(", ") : "none"}`,
            `**New winner(s):** ${result.newWinnerIds.length ? result.newWinnerIds.map((i) => `<@${i}>`).join(", ") : "No valid entries left"}`,
          ],
          emojiCategory: "action",
        },
        {
          guildId: guild.id,
          eventType: "giveaway_reroll",
          summary: `${refreshed.title || refreshed.prize} rerolled from the dashboard.`,
          channelId: refreshed.channelId,
          messageId: refreshed.messageId,
        },
      ).catch(() => null);
    }
  } else if (action === "pause") {
    if (giveaway.status !== "active") return { error: "Only an active giveaway can be paused." };
    await store.updateGiveaway(giveaway.id, { status: "paused", pausedAt: new Date() });
  } else if (action === "resume") {
    if (giveaway.status !== "paused") return { error: "Only a paused giveaway can be resumed." };
    const pausedMs = giveaway.pausedAt ? Date.now() - giveaway.pausedAt.getTime() : 0;
    await store.updateGiveaway(giveaway.id, {
      status: "active",
      pausedAt: null,
      endsAt: new Date(giveaway.endsAt.getTime() + Math.max(0, pausedMs)),
    });
  } else if (action === "cancel") {
    if (giveaway.status === "ended" || giveaway.status === "cancelled") {
      return { error: `Giveaway is already ${giveaway.status}.` };
    }
    await store.updateGiveaway(giveaway.id, { status: "cancelled" });
  }

  const refreshed = await store.getGiveaway(guild.id, id);
  if (!refreshed) return { error: "Giveaway not found after update" };

  if (refreshed.messageId) {
    if (action === "pause" || action === "resume") {
      await refreshGiveawayMessage(guild, refreshed).catch(() => null);
    } else if (action === "cancel") {
      await editLiveMessage(guild, refreshed, buildGiveawayCancelledEmbed(refreshed), []).catch(() => null);
    }
  }

  return { giveaway: await toWebGiveaway(refreshed) };
}

// -- Templates ---------------------------------------------------------------------------------

export async function listGuildGiveawayTemplates(guild: Guild): Promise<{ templates: WebGiveawayTemplate[] }> {
  const rows = await store.listTemplates(guild.id);
  return { templates: rows.map(toWebTemplate) };
}

export async function createGuildGiveawayTemplate(
  guild: Guild,
  actorId: string,
  name: string,
  settings: Record<string, unknown>,
): Promise<{ template: WebGiveawayTemplate } | { error: string }> {
  if (!name.trim()) return { error: "name is required" };
  const created = await store.createTemplate({ guildId: guild.id, name: name.trim(), settings, createdBy: actorId });
  return { template: toWebTemplate(created) };
}

export async function deleteGuildGiveawayTemplate(guild: Guild, id: number): Promise<{ ok: true } | { error: string }> {
  const existing = (await store.listTemplates(guild.id)).find((t) => t.id === id);
  if (!existing) return { error: "Template not found" };
  await store.deleteTemplate(id);
  return { ok: true };
}

// -- Preview -----------------------------------------------------------------------------------

/** Builds a throwaway `Giveaway`-shaped object from a partial create/edit draft and runs it
 *  through the real embed builder, so the dashboard preview matches what actually gets posted.
 *  Lenient like the role-panel/welcome previews: called on every keystroke, so an incomplete
 *  draft must still render something. */
export async function buildGiveawayPreview(
  _client: Client,
  guild: Guild,
  body: unknown,
): Promise<{ content: string; embed: Record<string, unknown> }> {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const embedConfig = zPersistEmbedConfig.parse(raw.embed ?? {});

  const now = new Date();
  const placeholder: Giveaway = {
    id: 0,
    guildId: guild.id,
    channelId: typeof raw.channelId === "string" ? raw.channelId : "",
    messageId: null,
    title: typeof raw.title === "string" ? raw.title : "",
    prize: typeof raw.prize === "string" ? raw.prize : "Prize",
    status: "active",
    entryMethod: raw.entryMethod === "reaction" ? "reaction" : "button",
    reactionEmoji: typeof raw.reactionEmoji === "string" ? raw.reactionEmoji : "🎉",
    buttonLabel: typeof raw.buttonLabel === "string" ? raw.buttonLabel : "Enter",
    buttonEmoji: typeof raw.buttonEmoji === "string" ? raw.buttonEmoji : "",
    buttonStyle: isButtonStyle(raw.buttonStyle) ? raw.buttonStyle : "primary",
    embedConfig,
    winnerCount: typeof raw.winnerCount === "number" && raw.winnerCount > 0 ? raw.winnerCount : 1,
    requireRoleIds: Array.isArray(raw.requireRoleIds) ? (raw.requireRoleIds as string[]) : [],
    requireRoleMode: raw.requireRoleMode === "all" ? "all" : "any",
    blacklistRoleIds: [],
    bypassRoleIds: [],
    minAccountAgeDays: typeof raw.minAccountAgeDays === "number" ? raw.minAccountAgeDays : 0,
    minJoinAgeDays: typeof raw.minJoinAgeDays === "number" ? raw.minJoinAgeDays : 0,
    bonusRoleWeights: [],
    boosterBonusWeight: 0,
    entryCost: 0,
    winBonus: 0,
    pingRoleId: null,
    dmWinner: true,
    dmNonWinners: false,
    claimWindowMinutes: 0,
    startsAt: now,
    endsAt: new Date(now.getTime() + 60 * 60_000),
    pausedAt: null,
    createdBy: "preview",
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };

  const entryCount = typeof raw.entryCount === "number" && raw.entryCount >= 0 ? raw.entryCount : 0;
  const embed = buildGiveawayEmbed(placeholder, entryCount, guild);
  return { content: "", embed: embed.toJSON() as Record<string, unknown> };
}
