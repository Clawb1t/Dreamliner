/**
 * YouTube subscriber milestones. Creators with `milestones` on are checked every few hours: their
 * channels' statistics come from channels.list, 50 channels per call (1 quota unit), and when one
 * has crossed a milestone since the last check, a celebration card goes to that creator's channel.
 *
 * The last announced milestone lives in the watcher's options (`milestone_last`). A creator that
 * was just switched on is "unseeded" (-1): its first check records where the channel is now,
 * without announcing, so turning the option on never celebrates milestones reached years ago.
 *
 * Twitch follower milestones aren't offered: Helix only returns follower totals to the
 * broadcaster's own (or a moderator's) user login, not to the bot's app token.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type Client } from "discord.js";
import { baseEmbed, type ResultContainer } from "../../../core/embeds.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { formatMilestone, nextMilestone } from "../../bluesky/functions/milestones.js";
import { MILESTONE_UNSEEDED, seedSubscriberMilestone, subscriberMilestoneToAnnounce } from "./logic.js";
import { fetchChannelsInfo, type ChannelInfo } from "./youtube.js";
import { listAllEnabledWatchers, refreshWatcherProfile, setWatcherOptions, type SocialWatcherRow } from "./store.js";
import { SOCIAL_EMOJIS } from "./notifyTwitch.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
const log = getLogger("social");

export const SOCIAL_MILESTONE_POLL_INTERVAL_MS = 6 * 60 * 60_000;
export const SOCIAL_MILESTONE_FIRST_POLL_DELAY_MS = 4 * 60_000;

const YOUTUBE_RED = 0xff0033;

/** The celebration card: the channel's avatar, the milestone as a heading, and its banner. */
export function buildSubscriberMilestoneCard(
  channel: Pick<ChannelInfo, "name" | "handle" | "avatarUrl" | "bannerUrl" | "url" | "subscriberCount">,
  milestone: number,
): { container: ResultContainer; row: ActionRowBuilder<ButtonBuilder> } {
  const subscribers = channel.subscriberCount ?? milestone;
  const next = nextMilestone(subscribers);
  const who = channel.handle ? `[${channel.handle}](${channel.url})` : `[${channel.name}](${channel.url})`;
  const description = [
    `-# ${SOCIAL_EMOJIS.trophy} Subscriber milestone`,
    `## ${channel.name} reached ${formatMilestone(milestone)} subscribers`,
    `${who} now has **${subscribers.toLocaleString("en-US")}** subscribers on YouTube. Next stop: ${formatMilestone(next)}.`,
  ].join("\n");
  const container = baseEmbed().setColor(YOUTUBE_RED).setDescription(description).setFooter({ text: `${SOCIAL_EMOJIS.youtube} YouTube` });
  if (channel.avatarUrl) container.setThumbnail(channel.avatarUrl);
  if (channel.bannerUrl) container.setImages([channel.bannerUrl]);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open channel").setStyle(ButtonStyle.Link).setURL(channel.url),
  );
  return { container, row };
}

async function announce(client: Client, watcher: SocialWatcherRow, channel: ChannelInfo, milestone: number): Promise<void> {
  const target = await fetchGuildChannel(client, watcher.guildId, watcher.discordChannelId);
  if (!target || !target.isTextBased() || !("send" in target)) return;
  const { container, row } = buildSubscriberMilestoneCard(channel, milestone);
  try {
    await target.send({
      components: [container.toContainerComponent([row.toJSON()])],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    log.warn(`[social] watcher ${watcher.id}: couldn't post the ${milestone} subscriber milestone:`, error);
  }
}

let running = false;

/** One pass over every YouTube creator with milestones on. Overlapping calls are skipped. */
export async function pollSubscriberMilestones(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const watchers = (await listAllEnabledWatchers()).filter((w) => w.options.milestones);
    if (!watchers.length) return;
    const channels = await fetchChannelsInfo(watchers.map((w) => w.sourceChannelId));

    const guildActive = new Map<string, boolean>();
    const refreshed = new Set<string>();
    for (const watcher of watchers) {
      const channel = channels.get(watcher.sourceChannelId);
      if (!channel) continue;

      if (
        !refreshed.has(channel.channelId) &&
        (channel.name !== watcher.sourceChannelName || channel.avatarUrl !== watcher.sourceChannelAvatarUrl)
      ) {
        refreshed.add(channel.channelId);
        await refreshWatcherProfile(channel.channelId, { name: channel.name, avatarUrl: channel.avatarUrl, handle: channel.handle }).catch(
          () => undefined,
        );
      }

      const last = watcher.options.milestone_last;
      if (last === MILESTONE_UNSEEDED) {
        const seed = seedSubscriberMilestone(channel.subscriberCount, channel.subscribersHidden);
        if (seed !== MILESTONE_UNSEEDED) await setWatcherOptions(watcher.id, { ...watcher.options, milestone_last: seed });
        continue;
      }
      const milestone = subscriberMilestoneToAnnounce(last, channel.subscriberCount, channel.subscribersHidden);
      if (milestone === null) continue;

      if (!guildActive.has(watcher.guildId)) {
        const config = await configManager.getEffectiveConfig(watcher.guildId).catch(() => null);
        guildActive.set(watcher.guildId, config ? pluginEnabled(config, "social") : false);
      }
      // Plugin off: remember the milestone anyway, so turning it back on doesn't post a stale one.
      if (guildActive.get(watcher.guildId)) await announce(client, watcher, channel, milestone);
      await setWatcherOptions(watcher.id, { ...watcher.options, milestone_last: milestone });
    }
  } finally {
    running = false;
  }
}

/** Starting point for a creator that just turned milestones on: where the channel is now, or unseeded. */
export async function seedYoutubeMilestone(channelId: string): Promise<number> {
  const channels = await fetchChannelsInfo([channelId]).catch(() => new Map<string, ChannelInfo>());
  const channel = channels.get(channelId);
  return channel ? seedSubscriberMilestone(channel.subscriberCount, channel.subscribersHidden) : MILESTONE_UNSEEDED;
}
