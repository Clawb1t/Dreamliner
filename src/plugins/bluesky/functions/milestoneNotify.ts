/**
 * Follower milestones. Feeds with `follower_milestones` on are checked every few hours: their
 * accounts' profiles are fetched 25 at a time (`app.bsky.actor.getProfiles`), and when one has
 * crossed a milestone since the last check, a celebration card goes to that feed's channel.
 *
 * The last announced milestone lives in the feed's options (`milestone_last`). A feed that was
 * just switched on is "unseeded" (-1): its first check records where the account is now, without
 * announcing, so turning the option on never celebrates milestones reached years ago.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type Client } from "discord.js";
import { baseEmbed, type ResultContainer } from "../../../core/embeds.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { BLUESKY_EMOJIS, blueskyFollowId } from "../constants.js";
import { getProfilesBatched, type BlueskyProfile } from "./api.js";
import { activeBlueskySettings } from "./guildSettings.js";
import { MILESTONE_UNSEEDED, formatMilestone, milestoneAtOrBelow, milestoneToAnnounce, nextMilestone } from "./milestones.js";
import { listAllEnabledFeeds, refreshFeedProfile, setFeedMilestone, type BlueskyFeedRow } from "./store.js";
const log = getLogger("bluesky");

/** How often follower counts are checked. */
export const MILESTONE_POLL_INTERVAL_MS = 6 * 60 * 60_000;
/** First check after the bot starts, so frequent restarts can't starve the 6-hourly task. */
export const MILESTONE_FIRST_POLL_DELAY_MS = 3 * 60_000;

/** The celebration card: the account's avatar, the milestone as a heading, and its banner. */
export function buildMilestoneCard(
  profile: Pick<BlueskyProfile, "did" | "handle" | "displayName" | "avatarUrl" | "bannerUrl" | "url" | "followersCount">,
  milestone: number,
  accentColor: number,
): { container: ResultContainer; row: ActionRowBuilder<ButtonBuilder> } {
  const next = nextMilestone(profile.followersCount);
  const description = [
    `-# ${BLUESKY_EMOJIS.trophy} Follower milestone`,
    `## ${profile.displayName} reached ${formatMilestone(milestone)} followers`,
    `[@${profile.handle}](${profile.url}) now has **${profile.followersCount.toLocaleString("en-US")}** followers on Bluesky. Next stop: ${formatMilestone(next)}.`,
  ].join("\n");
  const container = baseEmbed()
    .setColor(accentColor)
    .setThumbnail(profile.avatarUrl)
    .setDescription(description)
    .setFooter({ text: `${BLUESKY_EMOJIS.bluesky} Bluesky` });
  if (profile.bannerUrl) container.setImages([profile.bannerUrl]);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(blueskyFollowId(profile.did))
      .setLabel("Follow")
      .setEmoji(parseComponentEmoji(BLUESKY_EMOJIS.people) ?? "👥")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel("Open profile").setStyle(ButtonStyle.Link).setURL(profile.url),
  );
  return { container, row };
}

async function announce(client: Client, feed: BlueskyFeedRow, profile: BlueskyProfile, milestone: number): Promise<boolean> {
  const channel = await fetchGuildChannel(client, feed.guildId, feed.discordChannelId);
  if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
  const { container, row } = buildMilestoneCard(profile, milestone, feed.options.accent_color);
  try {
    await channel.send({
      components: [container.toContainerComponent([row.toJSON()])],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    log.warn(`[bluesky] feed ${feed.id}: couldn't post the ${milestone} follower milestone:`, error);
    return false;
  }
}

let running = false;

/** One pass over every feed with milestones on. Safe to call any time; overlapping calls are skipped. */
export async function pollFollowerMilestones(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const feeds = (await listAllEnabledFeeds()).filter((feed) => feed.options.follower_milestones);
    if (!feeds.length) return;

    const profiles = new Map<string, BlueskyProfile>();
    for (const profile of await getProfilesBatched(feeds.map((feed) => feed.did))) profiles.set(profile.did, profile);

    const guildActive = new Map<string, boolean>();
    const refreshed = new Set<string>();
    for (const feed of feeds) {
      const profile = profiles.get(feed.did);
      if (!profile) continue;

      // Keep stored names/avatars fresh while we're here (handles change).
      if (
        !refreshed.has(profile.did) &&
        (profile.handle !== feed.handle || profile.displayName !== feed.displayName || profile.avatarUrl !== feed.avatarUrl)
      ) {
        refreshed.add(profile.did);
        await refreshFeedProfile(profile.did, profile).catch(() => undefined);
      }

      const last = feed.options.milestone_last;
      if (last === MILESTONE_UNSEEDED) {
        await setFeedMilestone(feed.id, milestoneAtOrBelow(profile.followersCount));
        continue;
      }
      const milestone = milestoneToAnnounce(last, profile.followersCount);
      if (milestone === null) continue;

      if (!guildActive.has(feed.guildId)) guildActive.set(feed.guildId, Boolean(await activeBlueskySettings(feed.guildId)));
      // Plugin off: remember the milestone anyway, so turning it back on doesn't post a stale one.
      if (guildActive.get(feed.guildId)) await announce(client, feed, profile, milestone);
      await setFeedMilestone(feed.id, milestone);
    }
  } finally {
    running = false;
  }
}

/** Starting point for a feed that just turned milestones on: where the account is now, or unseeded. */
export async function seedMilestone(did: string): Promise<number> {
  const [profile] = await getProfilesBatched([did]).catch(() => []);
  return profile ? milestoneAtOrBelow(profile.followersCount) : MILESTONE_UNSEEDED;
}
