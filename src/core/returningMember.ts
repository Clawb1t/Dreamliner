import type { GuildMember } from "discord.js";
import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildMessageCounts, inviteJoins, memberIdentity } from "../db/schema.js";
import { capMap, createPruner } from "./mapPrune.js";

/**
 * "Was this member here before?" for Welcomer's welcome-back message. Uses the per-guild history
 * other plugins already keep, so it works whenever any of them was on when the member was last
 * here:
 *  - a Member Identity snapshot saved before this join (snapshots are only saved for members),
 *  - an Invite Tracker join row from before this join,
 *  - messages counted in this guild (Utility's message counter).
 *
 * The answer is captured once per join and remembered: a snapshot's timestamp moves as soon as
 * roles change after the join (autorole, Member Identity restore), so asking again later (for
 * example when a Passport-gated welcome is sent hours after the join) would lose that signal.
 */

/** Any record older than this many ms before the join counts. Absorbs small clock differences
 *  between Discord's join timestamp and ours. */
const JOIN_SKEW_MS = 2_000;
const REMEMBER_MS = 24 * 60 * 60_000;
const MAX_REMEMBERED = 20_000;

export type ReturningFacts = {
  joinedAt: number;
  /** Member Identity snapshot timestamp, if one exists. */
  snapshotAt: number | null;
  /** Earliest Invite Tracker join row, if one exists. */
  firstTrackedJoinAt: number | null;
  /** Messages counted for this member in this guild. */
  messageCount: number;
};

export function wasMemberBefore(facts: ReturningFacts): boolean {
  const cutoff = facts.joinedAt - JOIN_SKEW_MS;
  if (facts.snapshotAt !== null && facts.snapshotAt < cutoff) return true;
  if (facts.firstTrackedJoinAt !== null && facts.firstTrackedJoinAt < cutoff) return true;
  return facts.messageCount > 0;
}

function readFacts(guildId: string, userId: string, joinedAt: number): ReturningFacts {
  const db = getDb();
  const snapshot = db
    .select({ updatedAt: memberIdentity.updatedAt })
    .from(memberIdentity)
    .where(and(eq(memberIdentity.guildId, guildId), eq(memberIdentity.userId, userId)))
    .get();
  const priorJoin = db
    .select({ joinedAt: inviteJoins.joinedAt })
    .from(inviteJoins)
    .where(
      and(
        eq(inviteJoins.guildId, guildId),
        eq(inviteJoins.memberId, userId),
        lt(inviteJoins.joinedAt, new Date(joinedAt - JOIN_SKEW_MS)),
      ),
    )
    .orderBy(asc(inviteJoins.joinedAt))
    .limit(1)
    .get();
  const counted = db
    .select({ count: guildMessageCounts.count })
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.guildId, guildId), eq(guildMessageCounts.userId, userId)))
    .get();
  return {
    joinedAt,
    snapshotAt: snapshot?.updatedAt ? snapshot.updatedAt.getTime() : null,
    firstTrackedJoinAt: priorJoin?.joinedAt ? priorJoin.joinedAt.getTime() : null,
    messageCount: counted?.count ?? 0,
  };
}

const remembered = new Map<string, { returning: boolean; at: number }>();
const prune = createPruner(remembered, (entry, now) => now - entry.at >= REMEMBER_MS, 10 * 60_000);

/** Whether this member was in the guild before their current join. Call it as early as possible
 *  in a GuildMemberAdd handler so the answer is captured before anything else touches the member. */
export function isReturningMember(member: GuildMember): boolean {
  const joinedAt = member.joinedTimestamp ?? Date.now();
  const key = `${member.guild.id}:${member.id}:${joinedAt}`;
  const hit = remembered.get(key);
  if (hit) return hit.returning;

  let returning = false;
  try {
    returning = wasMemberBefore(readFacts(member.guild.id, member.id, joinedAt));
  } catch {
    returning = false;
  }
  const now = Date.now();
  prune(now);
  remembered.set(key, { returning, at: now });
  capMap(remembered, MAX_REMEMBERED);
  return returning;
}
