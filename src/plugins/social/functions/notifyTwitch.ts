import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type BaseMessageOptions, type Message } from "discord.js";
import type { SocialTwitchWatcherRow } from "./storeTwitch.js";
import type { LiveStream } from "./twitch.js";
import { buildNotificationPayload as buildPayload, sendNotification as send, type SendTweaks } from "./notifyShared.js";
import type { StreamSummary } from "./logic.js";

export const SOCIAL_EMOJIS = {
  youtube: "<:icons_youtube:1544417751022567455>",
  twitch: "<:icons_twitch:1544418152354685138>",
  live: "<:icons_live:1544417331822993408>",
  ended: "<:icons_stop_streaming:1544418214182649886>",
  trophy: "<:icons_trophy:1544418249721126922>",
  people: "<:icons_people:1544417371215626262>",
  play: "<:icons_play:1544417388408217641>",
} as const;

/** Tokens available in the top message, every embed text field, and button URLs. */
export const SOCIAL_TWITCH_TOKENS = [
  "stream_title",
  "stream_url",
  "stream_thumbnail",
  "game_name",
  "viewer_count",
  "started_at",
  "streamer_name",
  "streamer_handle",
  "streamer_url",
  "streamer_avatar",
] as const;
export type SocialTwitchTokenKey = (typeof SOCIAL_TWITCH_TOKENS)[number];

export function buildTwitchTokens(watcher: SocialTwitchWatcherRow, stream: LiveStream): Record<SocialTwitchTokenKey, string> {
  return {
    stream_title: stream.title,
    stream_url: stream.url,
    // Twitch caches preview images; a per-session query string makes Discord fetch a fresh one.
    stream_thumbnail: stream.thumbnailUrl ? `${stream.thumbnailUrl}?s=${encodeURIComponent(stream.streamId)}` : "",
    game_name: stream.gameName,
    viewer_count: String(stream.viewerCount),
    started_at: `<t:${Math.floor(stream.startedAt.getTime() / 1000)}:R>`,
    streamer_name: watcher.sourceUserDisplayName,
    streamer_handle: `@${watcher.sourceUserLogin}`,
    streamer_url: watcher.sourceUserUrl,
    streamer_avatar: watcher.sourceUserAvatarUrl ?? "",
  };
}

export function buildTwitchNotificationPayload(
  watcher: SocialTwitchWatcherRow,
  stream: LiveStream,
  tweaks?: SendTweaks,
): BaseMessageOptions {
  const tokens = buildTwitchTokens(watcher, stream);
  return buildPayload(watcher, tokens, "streamer_avatar", "stream_thumbnail", stream.startedAt, tweaks);
}

/** Send a "went live" notification for a watcher. Never throws; logs and returns null on failure. */
export async function sendTwitchNotification(
  client: Client,
  watcher: SocialTwitchWatcherRow,
  stream: LiveStream,
  tweaks?: SendTweaks,
): Promise<Message | null> {
  const tokens = buildTwitchTokens(watcher, stream);
  return send(client, watcher, tokens, "streamer_avatar", "stream_thumbnail", stream.startedAt, tweaks);
}

/** The stream-ended message: used to edit the live message, or posted as its own summary. */
export function buildStreamEndedPayload(watcher: SocialTwitchWatcherRow, summary: StreamSummary): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(0x6e6a86)
    .setAuthor({
      name: summary.heading.slice(0, 256),
      iconURL: watcher.sourceUserAvatarUrl ?? undefined,
      url: watcher.sourceUserUrl,
    })
    .setTitle(summary.title)
    .setURL(summary.button.url)
    .addFields(summary.fields)
    .setFooter({ text: "Stream ended" })
    .setTimestamp(new Date());
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(summary.button.label).setStyle(ButtonStyle.Link).setURL(summary.button.url),
  );
  const duration = summary.fields[0]?.value ?? "";
  return {
    content: `${SOCIAL_EMOJIS.ended} **${watcher.sourceUserDisplayName}** was live for ${duration}.`,
    embeds: [embed],
    components: [row],
  };
}
