import { eq, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  automodHits,
  evidenceMessages,
  guildMessageCounts,
  guildStatsUserDaily,
  guildUserTrail,
  memberIdentity,
  modCases,
  modStrikes,
  nameHistory,
  reminders,
  reviews,
  suggestionBlocks,
  suggestionComments,
  suggestionFollows,
  suggestionVotes,
  userBadges,
  userMessageCounts,
  usernameSnapshots,
  userProfiles,
  welcomeJoinMessages,
} from "../db/schema.js";

/** Recursively turns Date instances into ISO strings so the export is plain, human-readable JSON. */
function serializable<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (row instanceof Date) return row.toISOString() as unknown as T;
    if (Array.isArray(row)) return serializable(row) as unknown as T;
    if (row && typeof row === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key] = value instanceof Date ? value.toISOString() : value;
      }
      return out as T;
    }
    return row;
  });
}

export type UserDataExport = {
  userId: string;
  exportedAt: string;
  sections: Record<string, { label: string; description: string; rows: unknown[] }>;
};

/**
 * Every row across the database that is identifiable as this user, whether or not it's part of
 * the (smaller) set of data `deleteUserPersonalData` actually erases. Moderation history and
 * evidence are included here for transparency even though they're intentionally excluded from
 * the erase flow. This is "everything linked to you", not "everything we'll delete".
 */
export async function exportUserPersonalData(userId: string): Promise<UserDataExport> {
  const db = getDb();

  const sections: UserDataExport["sections"] = {
    profile: {
      label: "Profile",
      description: "Your accent color, bio, and profile visibility preferences.",
      rows: serializable(
        await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).all(),
      ),
    },
    guild_message_counts: {
      label: "Per-server message counts",
      description: "Lifetime messages tracked in each server (leaderboards & ranks).",
      rows: serializable(
        await db.select().from(guildMessageCounts).where(eq(guildMessageCounts.userId, userId)).all(),
      ),
    },
    user_message_counts: {
      label: "Global message total",
      description: "Your cross-server lifetime message counter.",
      rows: serializable(
        await db.select().from(userMessageCounts).where(eq(userMessageCounts.userId, userId)).all(),
      ),
    },
    guild_stats_user_daily: {
      label: "Daily message stats",
      description: "Per-day message activity used for charts and trends.",
      rows: serializable(
        await db.select().from(guildStatsUserDaily).where(eq(guildStatsUserDaily.userId, userId)).all(),
      ),
    },
    name_history: {
      label: "Name history",
      description: "Past nicknames / display names Dreamliner recorded.",
      rows: serializable(await db.select().from(nameHistory).where(eq(nameHistory.userId, userId)).all()),
    },
    username_snapshots: {
      label: "Username snapshots",
      description: "Stored username snapshots for change tracking.",
      rows: serializable(
        await db.select().from(usernameSnapshots).where(eq(usernameSnapshots.userId, userId)).all(),
      ),
    },
    member_identity: {
      label: "Member identity",
      description: "Saved nickname, roles, and timeout used to restore identity on rejoin.",
      rows: serializable(
        await db.select().from(memberIdentity).where(eq(memberIdentity.userId, userId)).all(),
      ),
    },
    reminders: {
      label: "Reminders",
      description: "Pending and past reminders you created.",
      rows: serializable(await db.select().from(reminders).where(eq(reminders.userId, userId)).all()),
    },
    reviews: {
      label: "Reviews",
      description: "Server reviews you submitted.",
      rows: serializable(await db.select().from(reviews).where(eq(reviews.userId, userId)).all()),
    },
    suggestion_votes: {
      label: "Suggestion votes",
      description: "Upvotes / downvotes on suggestions.",
      rows: serializable(
        await db.select().from(suggestionVotes).where(eq(suggestionVotes.userId, userId)).all(),
      ),
    },
    suggestion_follows: {
      label: "Suggestion follows",
      description: "Suggestions you follow for updates.",
      rows: serializable(
        await db.select().from(suggestionFollows).where(eq(suggestionFollows.userId, userId)).all(),
      ),
    },
    suggestion_comments: {
      label: "Suggestion comments",
      description: "Comments you left on suggestions.",
      rows: serializable(
        await db.select().from(suggestionComments).where(eq(suggestionComments.authorId, userId)).all(),
      ),
    },
    suggestion_blocks: {
      label: "Suggestion blocks",
      description: "Block records stored against your user id.",
      rows: serializable(
        await db.select().from(suggestionBlocks).where(eq(suggestionBlocks.userId, userId)).all(),
      ),
    },
    automod_hits: {
      label: "Automod hit history",
      description: "Records of automod rule hits attributed to you.",
      rows: serializable(await db.select().from(automodHits).where(eq(automodHits.userId, userId)).all()),
    },
    welcome_join_messages: {
      label: "Welcomer join records",
      description: "Join welcome / wave tracking messages tied to your account.",
      rows: serializable(
        await db.select().from(welcomeJoinMessages).where(eq(welcomeJoinMessages.memberId, userId)).all(),
      ),
    },
    badges: {
      label: "Badges",
      description: "Platform badges assigned to your account.",
      rows: serializable(await db.select().from(userBadges).where(eq(userBadges.userId, userId)).all()),
    },
    activity_trail: {
      label: "Activity trail",
      description:
        "Per-channel activity snippets used for risk scoring and last-seen lookups. Content clears per each server's own retention setting; the rest (channel, timing) is kept.",
      rows: serializable(
        await db.select().from(guildUserTrail).where(eq(guildUserTrail.userId, userId)).all(),
      ),
    },
    moderation_strikes: {
      label: "Moderation strike counts",
      description: "Per-server escalation strike counters, kept with server moderation history.",
      rows: serializable(await db.select().from(modStrikes).where(eq(modStrikes.userId, userId)).all()),
    },
    moderation_cases: {
      label: "Moderation cases",
      description:
        "Warns, mutes, kicks, bans, and notes where you're the subject or the moderator. Kept with the server regardless of account deletion, since it's the server's own accountability record.",
      rows: serializable(
        await db
          .select()
          .from(modCases)
          .where(or(eq(modCases.userId, userId), eq(modCases.modId, userId)))
          .all(),
      ),
    },
    evidence_messages: {
      label: "Evidence mode captures",
      description:
        "Message content snapshots captured when a moderation case was opened against you, or manually via /evidence add. Kept 42 days from capture regardless of account deletion.",
      rows: serializable(
        await db.select().from(evidenceMessages).where(eq(evidenceMessages.userId, userId)).all(),
      ),
    },
  };

  return { userId, exportedAt: new Date().toISOString(), sections };
}
