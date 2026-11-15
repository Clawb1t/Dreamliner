import type { Guild } from "discord.js";
import { and, countDistinct, count, eq } from "drizzle-orm";
import {
  ACTIVITY_CONTRIBUTION_METRICS,
  type ActivityRewardsConfig,
} from "../../../config/schemas/activityRewards.js";
import { getDb } from "../../../db/client.js";
import { starboardPosts, suggestions } from "../../../db/schema.js";
import { activeMilestones, hasIgnoredRole, loadActiveActivityRewards, type ActivityProgress } from "./config.js";
import { processMember } from "./rewards.js";
import { getProgress } from "./store.js";

/**
 * Contribution milestones: roles for a member's messages that made the Starboard and their
 * suggestions marked implemented. Roles only, never coins (the economy's anti-mint rule).
 *
 * Counts are read straight from the Starboard and Suggestions tables, so they're backfill-safe:
 * a milestone added later is reached by members who already have enough, on their next
 * starboard post, implemented suggestion, counted message or voice session, or a dashboard
 * import/sync. Starboard and Suggestions call onContributionChanged (guarded dynamic import)
 * whenever a new post lands or a suggestion is marked implemented.
 */

/** Distinct starboarded messages by this author in this guild (a message on two boards counts once). */
export function countStarboardPosts(guildId: string, userId: string): number {
  const row = getDb()
    .select({ n: countDistinct(starboardPosts.sourceMessageId) })
    .from(starboardPosts)
    .where(and(eq(starboardPosts.guildId, guildId), eq(starboardPosts.authorId, userId)))
    .get();
  return row?.n ?? 0;
}

/** This author's suggestions in this guild that staff marked implemented. */
export function countImplementedSuggestions(guildId: string, userId: string): number {
  const row = getDb()
    .select({ n: count() })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.guildId, guildId),
        eq(suggestions.authorId, userId),
        eq(suggestions.displayStatus, "implemented"),
      ),
    )
    .get();
  return row?.n ?? 0;
}

export function hasContributionMilestones(config: ActivityRewardsConfig): boolean {
  return activeMilestones(config).some((m) =>
    (ACTIVITY_CONTRIBUTION_METRICS as readonly string[]).includes(m.metric),
  );
}

export type ContributionCounters = {
  starboardPosts: (guildId: string, userId: string) => number;
  suggestionsImplemented: (guildId: string, userId: string) => number;
};

const DB_COUNTERS: ContributionCounters = {
  starboardPosts: countStarboardPosts,
  suggestionsImplemented: countImplementedSuggestions,
};

/** Adds contribution counts to `progress` when the guild has any milestone that needs them
 *  (only the ones in use are counted). Counts already present are kept. */
export function withContributions(
  guildId: string,
  userId: string,
  progress: ActivityProgress,
  config: ActivityRewardsConfig,
  counters: ContributionCounters = DB_COUNTERS,
): ActivityProgress {
  const metrics = new Set(activeMilestones(config).map((m) => m.metric));
  const next = { ...progress };
  try {
    if (metrics.has("starboard_posts") && next.starboardPosts === undefined) {
      next.starboardPosts = counters.starboardPosts(guildId, userId);
    }
    if (metrics.has("suggestions_implemented") && next.suggestionsImplemented === undefined) {
      next.suggestionsImplemented = counters.suggestionsImplemented(guildId, userId);
    }
  } catch {
    // Counting failed (e.g. a table not migrated yet): leave the contribution tracks at 0.
  }
  return next;
}

/** Re-checks one member's milestones after a contribution changed. */
export async function onContributionChanged(guild: Guild, userId: string): Promise<void> {
  const config = await loadActiveActivityRewards(guild.id);
  if (!config || !hasContributionMilestones(config)) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return;
  if (hasIgnoredRole(config, member.roles.cache.keys())) return;
  await processMember(member, config, getProgress(guild.id, userId));
}
