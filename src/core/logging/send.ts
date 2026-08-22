import type { Client, TextChannel } from "discord.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getGuildCasesDashboardUrl, getGuildLogsDashboardUrl } from "../docsUrl.js";
import { getModerationLogChannelId, getServerLogChannelId } from "./channels.js";
import { buildLogPayload } from "./container.js";
import { LOG_EVENT_META, type LogEventType } from "./events.js";
import { LOG_EMOJI, type LogEmojiCategory } from "./emojis.js";
import { insertGuildLogEvent, setGuildLogDiscordMessageId } from "./store.js";
import { isLogEventEnabled } from "./toggles.js";
import type { LogButton, LogCard } from "./types.js";

/** Maps a log emoji category to its field name in `guildConfig.logging.emojis`. */
const EMOJI_CONFIG_KEY: Record<LogEmojiCategory, keyof GuildConfig["logging"]["emojis"]> = {
  action: "action_emoji",
  create: "create_emoji",
  delete: "delete_emoji",
  edit: "edit_emoji",
  emojiSticker: "emoji_sticker_emoji",
  join: "join_emoji",
  leave: "leave_emoji",
  voice: "voice_emoji",
  unban: "unban_emoji",
  serverUpdate: "server_update_emoji",
  modDefault: "moderation_default_emoji",
  modModerate: "moderation_moderate_emoji",
  modSevere: "moderation_severe_emoji",
};

/** Resolves a card's emoji category to the guild's configured glyph, falling back to Dreamliner's default. */
function resolveCardEmoji(category: LogEmojiCategory | undefined, guildConfig: GuildConfig): string {
  const cat = category ?? "action";
  const configured = guildConfig.logging?.emojis?.[EMOJI_CONFIG_KEY[cat]];
  return configured?.trim() ? configured : LOG_EMOJI[cat];
}

export type LogEmitMeta = {
  guildId: string;
  eventType: LogEventType;
  summary?: string;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  caseId?: number | null;
  payload?: Record<string, unknown>;
  caseLogOverride?: string | null;
};

export type EmitLogOptions = {
  /** Send even if this event type is toggled off for the guild (used by the "test logs" feature). */
  skipToggleCheck?: boolean;
  /** Don't write a row to guild_log_events / the dashboard Logs history (test sends). */
  skipPersist?: boolean;
  /** Skip the automatic Jump to Message / View in Dashboard buttons. */
  skipAutoButtons?: boolean;
};

function jumpToMessageButton(guildId: string, channelId: string, messageId: string): LogButton {
  return {
    label: "Jump to Message",
    url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
    style: "link",
    emoji: "🔗",
  };
}

function dashboardButton(guildId: string, category: "server" | "moderation"): LogButton {
  return category === "moderation"
    ? { label: "View in Dashboard", url: getGuildCasesDashboardUrl(guildId), style: "link", emoji: "📊" }
    : { label: "View in Dashboard", url: getGuildLogsDashboardUrl(guildId), style: "link", emoji: "📊" };
}

/** Adds Jump to Message / View in Dashboard buttons when useful, on top of any card-specific ones. */
function withAutoButtons(
  card: LogCard,
  meta: LogEmitMeta,
  category: "server" | "moderation",
  options?: EmitLogOptions,
): LogCard {
  if (options?.skipAutoButtons) return card;

  const buttons: LogButton[] = [...(card.buttons ?? [])];
  if (meta.channelId && meta.messageId) {
    buttons.push(jumpToMessageButton(meta.guildId, meta.channelId, meta.messageId));
  }
  buttons.push(dashboardButton(meta.guildId, category));

  return { ...card, buttons: buttons.slice(0, 5) };
}

async function sendToChannel(
  client: Client,
  channelId: string,
  card: LogCard,
): Promise<string | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("send" in channel)) return null;
  const sent = await (channel as TextChannel).send(buildLogPayload(card)).catch(() => null);
  return sent?.id ?? null;
}

function summarizeCard(card: LogCard, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim().slice(0, 500);
  const line = card.information.find((item) => item.trim().length > 0);
  return (line ?? card.title).replace(/\s+/g, " ").slice(0, 500);
}

export async function emitLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
  options?: EmitLogOptions,
): Promise<string | null> {
  if (!options?.skipToggleCheck && !isLogEventEnabled(guildConfig, meta.eventType)) return null;

  const category = LOG_EVENT_META[meta.eventType].category;
  const emoji = resolveCardEmoji(card.emojiCategory, guildConfig);
  const titledCard = { ...card, title: `${emoji} ${card.title}` };
  const finalCard = withAutoButtons(titledCard, meta, category, options);

  let logId: string | null = null;
  if (!options?.skipPersist) {
    logId = await insertGuildLogEvent({
      guildId: meta.guildId,
      category,
      eventType: meta.eventType,
      title: finalCard.title,
      summary: summarizeCard(finalCard, meta.summary),
      actorId: meta.actorId,
      targetId: meta.targetId,
      channelId: meta.channelId,
      messageId: meta.messageId,
      caseId: meta.caseId,
      payload: {
        title: finalCard.title,
        information: finalCard.information,
        extra: finalCard.extra ?? null,
        avatarUrl: finalCard.avatarUrl ?? null,
        buttons: finalCard.buttons?.map((b) => ({ label: b.label, url: b.url })) ?? [],
        files: finalCard.files?.map((f) => ({ name: f.name, size: f.content.length })) ?? [],
        ...(meta.payload ?? {}),
      },
    });
  }

  const channelId =
    category === "moderation"
      ? getModerationLogChannelId(guildConfig, meta.caseLogOverride)
      : getServerLogChannelId(guildConfig);

  let discordMessageId: string | null = null;
  if (channelId) {
    discordMessageId = await sendToChannel(client, channelId, finalCard);
    if (discordMessageId && logId) {
      await setGuildLogDiscordMessageId(meta.guildId, logId, discordMessageId).catch(() => null);
    }
  }

  // Persisted sends return the history row id; unpersisted ones (e.g. test sends) return the
  // Discord message id instead, so callers can still tell whether the send actually landed.
  return options?.skipPersist ? discordMessageId : logId;
}

export async function sendModerationLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
): Promise<void> {
  await emitLog(client, guildConfig, card, meta);
}

export async function sendServerLog(
  client: Client,
  guildConfig: GuildConfig,
  card: LogCard,
  meta: LogEmitMeta,
): Promise<void> {
  await emitLog(client, guildConfig, card, meta);
}
