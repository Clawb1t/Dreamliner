import type { InviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import type { FakeReason, JoinStatus } from "./config.js";

const DAY_MS = 86_400_000;

export type JoinClassification = {
  status: JoinStatus;
  fakeReason: FakeReason | null;
  /** False for a rejoin under `rejoin_policy: ignore`: recorded for history, never counted. */
  counted: boolean;
};

export type JoinFacts = {
  memberId: string;
  inviterId: string | null;
  isBot: boolean;
  accountCreatedAt: number;
  joinedAt: number;
  /** The member has joined this server before (any earlier join row). */
  isRejoin: boolean;
  /** Roles the inviter holds right now (empty when they aren't in the server). */
  inviterRoleIds?: Iterable<string>;
  /** `count_on: verified` and the member still has to pass Passport. */
  awaitingVerification: boolean;
};

type ClassifyConfig = Pick<InviteTrackerConfig, "ignore_bots" | "blacklist" | "fake">;

/** The first fake reason that applies to a join, checked in a fixed order, or null. */
export function fakeReasonFor(facts: JoinFacts, config: ClassifyConfig): FakeReason | null {
  if (facts.isBot && config.ignore_bots) return "bot";
  if (facts.inviterId && facts.inviterId === facts.memberId) return "self";
  const blockedUsers = config.blacklist.user_ids;
  if (blockedUsers.includes(facts.memberId) || (facts.inviterId && blockedUsers.includes(facts.inviterId))) {
    return "blacklist";
  }
  if (config.blacklist.role_ids.length > 0 && facts.inviterRoleIds) {
    for (const id of facts.inviterRoleIds) if (config.blacklist.role_ids.includes(id)) return "blacklist";
  }
  const minAgeDays = config.fake.min_account_age_days;
  if (minAgeDays > 0 && facts.joinedAt - facts.accountCreatedAt < minAgeDays * DAY_MS) return "account_age";
  if (facts.isRejoin && config.fake.rejoin_policy === "fake") return "rejoin";
  return null;
}

/** A new join's status: fake when any reason applies, pending while it waits on Passport, else valid. */
export function classifyJoin(facts: JoinFacts, config: ClassifyConfig): JoinClassification {
  const counted = !(facts.isRejoin && config.fake.rejoin_policy === "ignore");
  const fakeReason = fakeReasonFor(facts, config);
  if (fakeReason) return { status: "fake", fakeReason, counted };
  if (facts.awaitingVerification) return { status: "pending", fakeReason: null, counted };
  return { status: "valid", fakeReason: null, counted };
}

/** A pending join once the member passes Passport. Fake joins stay fake. */
export function classifyVerified(current: { status: JoinStatus; fakeReason: FakeReason | null }): {
  status: JoinStatus;
  fakeReason: FakeReason | null;
} {
  return current.status === "pending" ? { status: "valid", fakeReason: null } : current;
}

/**
 * A join once its member leaves: still pending means they never verified (fake, unverified); a
 * valid join that lasted less than `quick_leave_minutes` is fake when `quick_leave_as: fake`.
 * Anything else keeps its status (a valid join with `left_at` set counts as left).
 */
export function classifyLeave(
  current: { status: JoinStatus; fakeReason: FakeReason | null; joinedAt: number },
  leftAt: number,
  config: Pick<InviteTrackerConfig, "fake">,
): { status: JoinStatus; fakeReason: FakeReason | null } {
  if (current.status === "pending") return { status: "fake", fakeReason: "unverified" };
  if (current.status !== "valid") return { status: current.status, fakeReason: current.fakeReason };
  const { quick_leave_minutes, quick_leave_as } = config.fake;
  if (quick_leave_minutes > 0 && quick_leave_as === "fake" && leftAt - current.joinedAt < quick_leave_minutes * 60_000) {
    return { status: "fake", fakeReason: "quick_leave" };
  }
  return { status: "valid", fakeReason: null };
}

/** Whether a pending join has waited longer than `passport.pending_timeout_hours`. */
export function pendingTimedOut(joinedAt: number, now: number, config: Pick<InviteTrackerConfig, "passport">): boolean {
  return now - joinedAt >= config.passport.pending_timeout_hours * 3_600_000;
}
