import { count, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  automodHits,
  guildMessageCounts,
  guildStatsUserDaily,
  nameHistory,
  memberIdentity,
  reminders,
  reviews,
  suggestionBlocks,
  suggestionComments,
  suggestionFollows,
  suggestionVotes,
  userMessageCounts,
  usernameSnapshots,
  userProfiles,
  welcomeJoinMessages,
} from "../db/schema.js";
import { DEFAULT_CONTENT_RETENTION_DAYS } from "../core/contentRetention.js";

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const BIO_MAX_LENGTH = 280;

export type UserProfile = {
  userId: string;
  accentColor: string | null;
  bio: string | null;
  profileVisible: boolean;
  showNavBalance: boolean;
  showNavExchange: boolean;
  showTradingCards: boolean;
  contentRetentionDays: number;
  updatedAt: string | null;
};

export function normalizeAccentColor(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!ACCENT_RE.test(withHash)) return undefined;
  return withHash.toLowerCase();
}

/** Returns `undefined` for "field not provided", `null`/string for a valid value, or throws on invalid input. */
export function normalizeBio(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, BIO_MAX_LENGTH);
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const row = await getDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get();
  return {
    userId,
    accentColor: row?.accentColor ?? null,
    bio: row?.bio ?? null,
    profileVisible: row?.profileVisible ?? true,
    showNavBalance: row?.showNavBalance ?? false,
    showNavExchange: row?.showNavExchange ?? false,
    showTradingCards: row?.showTradingCards ?? false,
    contentRetentionDays: row?.contentRetentionDays ?? DEFAULT_CONTENT_RETENTION_DAYS,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function getAccentColorsForUsers(
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;

  const rows = await getDb()
    .select({
      userId: userProfiles.userId,
      accentColor: userProfiles.accentColor,
    })
    .from(userProfiles)
    .where(inArray(userProfiles.userId, unique))
    .all();

  for (const row of rows) {
    if (row.accentColor && ACCENT_RE.test(row.accentColor)) {
      map.set(row.userId, row.accentColor.toLowerCase());
    }
  }
  return map;
}

export type UpsertUserProfileInput = {
  accentColor?: string | null;
  bio?: string | null;
  profileVisible?: boolean;
  showNavBalance?: boolean;
  showNavExchange?: boolean;
  showTradingCards?: boolean;
  contentRetentionDays?: number;
};

export async function upsertUserProfileFields(
  userId: string,
  fields: UpsertUserProfileInput,
): Promise<UserProfile> {
  const now = new Date();
  const existing = await getDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get();

  const patch: Omit<typeof userProfiles.$inferInsert, "userId"> = { updatedAt: now };
  if ("accentColor" in fields) patch.accentColor = fields.accentColor ?? null;
  if ("bio" in fields) patch.bio = fields.bio ?? null;
  if ("profileVisible" in fields && fields.profileVisible !== undefined) {
    patch.profileVisible = fields.profileVisible;
  }
  if ("showNavBalance" in fields && fields.showNavBalance !== undefined) {
    patch.showNavBalance = fields.showNavBalance;
  }
  if ("showNavExchange" in fields && fields.showNavExchange !== undefined) {
    patch.showNavExchange = fields.showNavExchange;
  }
  if ("showTradingCards" in fields && fields.showTradingCards !== undefined) {
    patch.showTradingCards = fields.showTradingCards;
  }
  if ("contentRetentionDays" in fields && fields.contentRetentionDays !== undefined) {
    patch.contentRetentionDays = fields.contentRetentionDays;
  }

  if (existing) {
    await getDb().update(userProfiles).set(patch).where(eq(userProfiles.userId, userId));
  } else {
    await getDb()
      .insert(userProfiles)
      .values({ userId, ...patch });
  }

  if ("contentRetentionDays" in fields) {
    const { invalidateContentRetentionCache } = await import("../core/contentRetention.js");
    invalidateContentRetentionCache(userId);
  }

  return getUserProfile(userId);
}

/** @deprecated use upsertUserProfileFields */
export async function upsertUserAccent(
  userId: string,
  accentColor: string | null,
): Promise<UserProfile> {
  return upsertUserProfileFields(userId, { accentColor });
}

export type DeleteUserDataResult = {
  ok: true;
  userId: string;
  deleted: Record<string, number>;
};

export type UserDataInventoryItem = {
  key: string;
  label: string;
  description: string;
  count: number;
};

export type UserDataInventory = {
  userId: string;
  items: UserDataInventoryItem[];
  totalRecords: number;
  kept: Array<{ label: string; description: string }>;
};

async function countRows(
  run: () => { total: number } | undefined | Promise<{ total: number } | undefined>,
): Promise<number> {
  const row = await Promise.resolve(run());
  return Number(row?.total ?? 0);
}

/** Count personal records that would be erased (does not delete). */
export async function previewUserPersonalData(userId: string): Promise<UserDataInventory> {
  const db = getDb();
  const defs: Array<{
    key: string;
    label: string;
    description: string;
    total: Promise<number>;
  }> = [
    {
      key: "user_profiles",
      label: "Profile accent",
      description: "Your chosen leaderboard color and profile preference.",
      total: countRows(() =>
        db.select({ total: count() }).from(userProfiles).where(eq(userProfiles.userId, userId)).get(),
      ),
    },
    {
      key: "guild_message_counts",
      label: "Per-server message counts",
      description: "Lifetime messages tracked in each server (leaderboards & ranks).",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(guildMessageCounts)
          .where(eq(guildMessageCounts.userId, userId))
          .get(),
      ),
    },
    {
      key: "user_message_counts",
      label: "Global message total",
      description: "Your cross-server lifetime message counter.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(userMessageCounts)
          .where(eq(userMessageCounts.userId, userId))
          .get(),
      ),
    },
    {
      key: "guild_stats_user_daily",
      label: "Daily message stats",
      description: "Per-day message activity used for charts and trends.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(guildStatsUserDaily)
          .where(eq(guildStatsUserDaily.userId, userId))
          .get(),
      ),
    },
    {
      key: "name_history",
      label: "Name history",
      description: "Past nicknames / display names Dreamliner recorded.",
      total: countRows(() =>
        db.select({ total: count() }).from(nameHistory).where(eq(nameHistory.userId, userId)).get(),
      ),
    },
    {
      key: "username_snapshots",
      label: "Username snapshots",
      description: "Stored username snapshots for change tracking.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(usernameSnapshots)
          .where(eq(usernameSnapshots.userId, userId))
          .get(),
      ),
    },
    {
      key: "member_identity",
      label: "Member identity",
      description: "Saved nickname, roles, and timeout used to restore identity on rejoin.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(memberIdentity)
          .where(eq(memberIdentity.userId, userId))
          .get(),
      ),
    },
    {
      key: "reminders",
      label: "Reminders",
      description: "Pending and past reminders you created.",
      total: countRows(() =>
        db.select({ total: count() }).from(reminders).where(eq(reminders.userId, userId)).get(),
      ),
    },
    {
      key: "reviews",
      label: "Reviews",
      description: "Server reviews you submitted.",
      total: countRows(() =>
        db.select({ total: count() }).from(reviews).where(eq(reviews.userId, userId)).get(),
      ),
    },
    {
      key: "suggestion_votes",
      label: "Suggestion votes",
      description: "Upvotes / downvotes on suggestions.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(suggestionVotes)
          .where(eq(suggestionVotes.userId, userId))
          .get(),
      ),
    },
    {
      key: "suggestion_follows",
      label: "Suggestion follows",
      description: "Suggestions you follow for updates.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(suggestionFollows)
          .where(eq(suggestionFollows.userId, userId))
          .get(),
      ),
    },
    {
      key: "suggestion_comments",
      label: "Suggestion comments",
      description: "Comments you left on suggestions.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(suggestionComments)
          .where(eq(suggestionComments.authorId, userId))
          .get(),
      ),
    },
    {
      key: "suggestion_blocks",
      label: "Suggestion blocks",
      description: "Block records stored against your user id.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(suggestionBlocks)
          .where(eq(suggestionBlocks.userId, userId))
          .get(),
      ),
    },
    {
      key: "automod_hits",
      label: "Automod hit history",
      description: "Records of automod rule hits attributed to you.",
      total: countRows(() =>
        db.select({ total: count() }).from(automodHits).where(eq(automodHits.userId, userId)).get(),
      ),
    },
    {
      key: "welcome_join_messages",
      label: "Welcomer join records",
      description: "Join welcome / wave tracking messages tied to your account.",
      total: countRows(() =>
        db
          .select({ total: count() })
          .from(welcomeJoinMessages)
          .where(eq(welcomeJoinMessages.memberId, userId))
          .get(),
      ),
    },
  ];

  const items: UserDataInventoryItem[] = await Promise.all(
    defs.map(async (entry) => ({
      key: entry.key,
      label: entry.label,
      description: entry.description,
      count: await entry.total,
    })),
  );

  return {
    userId,
    items,
    totalRecords: items.reduce((sum, item) => sum + item.count, 0),
    kept: [
      {
        label: "Moderation cases",
        description: "Warns, mutes, bans, and other staff cases stay with the server.",
      },
      {
        label: "Server configuration",
        description: "Guild settings and plugin config are not personal data and are kept.",
      },
      {
        label: "Moderation message log",
        description:
          "The edit/delete audit trail staff use to investigate reports is retained for 42 days regardless of your content retention setting.",
      },
      {
        label: "Message content retention",
        description:
          "Your chosen content retention window (Account → Message retention) governs archives and activity-tracker snippets — this deletion doesn't change that setting.",
      },
    ],
  };
}

/** Erase personal analytics / preference data. Keeps moderation case history. */
export async function deleteUserPersonalData(userId: string): Promise<DeleteUserDataResult> {
  const db = getDb();
  const deleted: Record<string, number> = {};

  const wipe = async (key: string, rows: Promise<unknown[]>) => {
    deleted[key] = (await rows).length;
  };

  await wipe(
    "user_profiles",
    db.delete(userProfiles).where(eq(userProfiles.userId, userId)).returning(),
  );
  await wipe(
    "guild_message_counts",
    db.delete(guildMessageCounts).where(eq(guildMessageCounts.userId, userId)).returning(),
  );
  await wipe(
    "user_message_counts",
    db.delete(userMessageCounts).where(eq(userMessageCounts.userId, userId)).returning(),
  );
  await wipe(
    "guild_stats_user_daily",
    db.delete(guildStatsUserDaily).where(eq(guildStatsUserDaily.userId, userId)).returning(),
  );
  await wipe(
    "name_history",
    db.delete(nameHistory).where(eq(nameHistory.userId, userId)).returning(),
  );
  await wipe(
    "username_snapshots",
    db.delete(usernameSnapshots).where(eq(usernameSnapshots.userId, userId)).returning(),
  );
  await wipe(
    "member_identity",
    db.delete(memberIdentity).where(eq(memberIdentity.userId, userId)).returning(),
  );
  await wipe(
    "reminders",
    db.delete(reminders).where(eq(reminders.userId, userId)).returning(),
  );
  await wipe(
    "reviews",
    db.delete(reviews).where(eq(reviews.userId, userId)).returning(),
  );
  await wipe(
    "suggestion_votes",
    db.delete(suggestionVotes).where(eq(suggestionVotes.userId, userId)).returning(),
  );
  await wipe(
    "suggestion_follows",
    db.delete(suggestionFollows).where(eq(suggestionFollows.userId, userId)).returning(),
  );
  await wipe(
    "suggestion_comments",
    db.delete(suggestionComments).where(eq(suggestionComments.authorId, userId)).returning(),
  );
  await wipe(
    "suggestion_blocks",
    db.delete(suggestionBlocks).where(eq(suggestionBlocks.userId, userId)).returning(),
  );
  await wipe(
    "automod_hits",
    db.delete(automodHits).where(eq(automodHits.userId, userId)).returning(),
  );
  await wipe(
    "welcome_join_messages",
    db.delete(welcomeJoinMessages).where(eq(welcomeJoinMessages.memberId, userId)).returning(),
  );

  return { ok: true, userId, deleted };
}
