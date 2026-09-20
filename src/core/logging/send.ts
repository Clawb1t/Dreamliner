import type { Client, TextChannel } from "discord.js";
import type { GuildConfig } from "../../config/schemas/guild.js";
import { getEventChannelOverride, getModerationLogChannelId, getServerLogChannelId } from "./channels.js";
import { buildLogPayload } from "./container.js";
import { LOG_EVENT_META, type LogEventType } from "./events.js";
import { LOG_EMOJI, type LogEmojiCategory } from "./emojis.js";
import { insertGuildLogEvent, setGuildLogDiscordMessageId } from "./store.js";
import { isLogEventEnabled } from "./toggles.js";
import type { LogButton, LogCard } from "./types.js";
import { getLogger } from "../logger.js";

const log = getLogger("logs");

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
  /** Skip the automatic Jump to Message button. */
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

/** Adds a Jump to Message button when useful, on top of any card-specific ones. */
function withAutoButtons(
  card: LogCard,
  meta: LogEmitMeta,
  options?: EmitLogOptions,
): LogCard {
  if (options?.skipAutoButtons) return card;
  if (!meta.channelId || !meta.messageId) return card;

  const buttons: LogButton[] = [
    ...(card.buttons ?? []),
    jumpToMessageButton(meta.guildId, meta.channelId, meta.messageId),
  ];

  return { ...card, buttons: buttons.slice(0, 5) };
}

async function sendToChannel(
  client: Client,
  guildId: string,
  channelId: string,
  card: LogCard,
): Promise<string | null> {
  const channel = await client.channels.fetch(channelId).catch((error) => {
    log.warn(
      `Could not fetch log channel ${channelId} in guild ${guildId} — it may have been deleted, or I've lost access. (${error instanceof Error ? error.message : error})`,
    );
    return null;
  });
  if (!channel) return null;
  if (!channel.isTextBased() || !("send" in channel)) {
    log.warn(`Log channel ${channelId} in guild ${guildId} is not a sendable text channel — skipped "${card.title}".`);
    return null;
  }
  const sent = await (channel as TextChannel).send(buildLogPayload(card)).catch((error) => {
    log.error(
      `Failed to send "${card.title}" to log channel ${channelId} in guild ${guildId} (likely missing View Channel / Send Messages permission):`,
      error instanceof Error ? error.message : error,
    );
    return null;
  });
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
  const finalCard = withAutoButtons(titledCard, meta, options);

  let logId: string | null = null;
  if (!options?.skipPersist) {
    // Never let a DB hiccup here block the actual Discord send below — the dashboard history
    // row is a nice-to-have, the moderator seeing the log in their channel is the point.
    try {
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
    } catch (error) {
      log.error(`Failed to persist log event "${meta.eventType}" for guild ${meta.guildId}:`, error);
    }
  }

  const channelId =
    getEventChannelOverride(guildConfig, meta.eventType) ??
    (category === "moderation"
      ? getModerationLogChannelId(guildConfig, meta.caseLogOverride)
      : getServerLogChannelId(guildConfig));

  let discordMessageId: string | null = null;
  if (channelId) {
    discordMessageId = await sendToChannel(client, meta.guildId, channelId, finalCard);
    if (discordMessageId && logId) {
      await setGuildLogDiscordMessageId(meta.guildId, logId, discordMessageId).catch(() => null);
    }
  } else {
    log.debug(
      `No ${category} log channel configured for guild ${meta.guildId} — "${finalCard.title}" was not sent to Discord${
        options?.skipPersist ? "" : " (still recorded in the dashboard Logs history)"
      }.`,
    );
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
