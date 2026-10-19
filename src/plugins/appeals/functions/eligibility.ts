import type { AppealsConfig } from "../../../config/schemas/appeals.js";
import { durationMs, ruleFor } from "./config.js";
import { OPEN_STATUSES, type AppealRecord } from "./store.js";

/**
 * Who can appeal what, and when. Pure (no Discord, no database) so every rule is easy to test:
 * callers pass in the user's infractions, their past appeals and a little about them.
 */

export type CaseLike = {
  id: number;
  type: string;
  reason: string | null;
  modId: string;
  active: boolean;
  createdAt: Date;
  expiresAt: Date | null;
};

export type CaseState =
  /** Can be appealed now. */
  | "appealable"
  /** Too soon after the infraction: `until` says when. */
  | "wait"
  /** Past the type's appeal window. */
  | "window_closed"
  /** An appeal for it is already open (`appealId`). */
  | "already_open"
  /** Appealed as many times as the server allows. */
  | "max_reached"
  /** A recent appeal was denied: `until` says when it can be tried again. */
  | "cooldown"
  /** Expired or already lifted, and the server doesn't take appeals for those. */
  | "inactive"
  /** An appeal for it was already approved. */
  | "resolved";

export type CaseOption = {
  case: CaseLike;
  state: CaseState;
  until: Date | null;
  appealId: number | null;
  formId: string;
};

export type ManualState = "appealable" | "disabled" | "not_banned" | "already_open" | "max_reached" | "cooldown";

export type BlockReason =
  | { kind: "blocked" }
  /** Discord account younger than the server allows: `until` says when it's old enough. */
  | { kind: "account_too_new"; until: Date }
  /** Already has as many open appeals as the server allows. */
  | { kind: "too_many_open"; max: number };

/** One of the server's own options (`custom_options`): a manual appeal with its own title and form. */
export type CustomOption = {
  id: string;
  label: string;
  description: string;
  state: ManualState;
  until: Date | null;
  appealId: number | null;
  formId: string;
};

export type AppealOptions = {
  cases: CaseOption[];
  manual: { state: ManualState; until: Date | null; appealId: number | null; formId: string };
  /** Enabled custom options only, in the server's order. */
  custom: CustomOption[];
  /** When set, nothing can be submitted right now, whatever each case's own state is. */
  block: BlockReason | null;
};

export type ViewerFacts = {
  isBanned: boolean;
  isMember: boolean;
  accountCreatedAt: Date;
  memberRoleIds: string[];
};

/** Kicks and softbans happen once and are stored inactive from the start, so "inactive" only
 *  means "lifted or expired" for the punishments that last. */
const ONE_OFF_TYPES = new Set(["kick", "softban"]);

/** Applies the per-appeal history rules (open, resolved, max, cooldown) shared by cases and manual appeals. */
function historyState(
  config: AppealsConfig,
  history: AppealRecord[],
  now: Date,
): { state: "already_open" | "resolved" | "max_reached" | "cooldown"; until: Date | null; appealId: number | null } | null {
  const open = history.find((appeal) => OPEN_STATUSES.includes(appeal.status));
  if (open) return { state: "already_open", until: null, appealId: open.id };
  if (history.some((appeal) => appeal.status === "approved")) return { state: "resolved", until: null, appealId: null };
  const counted = history.filter((appeal) => appeal.status !== "withdrawn");
  if (counted.length >= config.limits.max_per_case) return { state: "max_reached", until: null, appealId: null };
  const lastDenied = counted
    .filter((appeal) => appeal.status === "denied" && appeal.decidedAt)
    .sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0];
  const cooldown = durationMs(config.limits.deny_cooldown);
  if (lastDenied && cooldown > 0) {
    const until = new Date(lastDenied.decidedAt!.getTime() + cooldown);
    if (until > now) return { state: "cooldown", until, appealId: null };
  }
  return null;
}

export function appealOptions(
  config: AppealsConfig,
  cases: CaseLike[],
  appeals: AppealRecord[],
  now: Date,
  viewer: ViewerFacts & { userId: string },
): AppealOptions {
  const options: CaseOption[] = [];
  for (const infraction of cases) {
    const rule = ruleFor(config, infraction.type);
    if (!rule?.enabled) continue; // types the server doesn't take appeals for aren't listed at all

    const base = { case: infraction, formId: rule.form_id };
    const history = historyState(
      config,
      appeals.filter((appeal) => appeal.caseId === infraction.id),
      now,
    );
    if (history) {
      options.push({ ...base, state: history.state, until: history.until, appealId: history.appealId });
      continue;
    }
    if (!infraction.active && !ONE_OFF_TYPES.has(infraction.type) && !rule.allow_inactive) {
      options.push({ ...base, state: "inactive", until: null, appealId: null });
      continue;
    }
    const window = durationMs(rule.window);
    if (window > 0 && now.getTime() > infraction.createdAt.getTime() + window) {
      options.push({ ...base, state: "window_closed", until: null, appealId: null });
      continue;
    }
    const wait = durationMs(rule.min_wait);
    const ready = new Date(infraction.createdAt.getTime() + wait);
    if (wait > 0 && ready > now) {
      options.push({ ...base, state: "wait", until: ready, appealId: null });
      continue;
    }
    options.push({ ...base, state: "appealable", until: null, appealId: null });
  }

  // Manual appeals (nothing on file).
  const manualBase = { formId: config.manual.form_id, appealId: null as number | null, until: null as Date | null };
  let manual: AppealOptions["manual"];
  if (!config.manual.enabled) manual = { ...manualBase, state: "disabled" };
  else if (config.manual.require_ban && !viewer.isBanned) manual = { ...manualBase, state: "not_banned" };
  else {
    const history = historyState(
      config,
      appeals.filter((appeal) => appeal.kind === "manual" && !appeal.option),
      now,
    );
    manual =
      history && history.state !== "resolved"
        ? { ...manualBase, state: history.state, until: history.until, appealId: history.appealId }
        : { ...manualBase, state: "appealable" };
  }

  // The server's own options: each keeps its own history (one appeal per option, like a case).
  const custom: CustomOption[] = config.custom_options
    .filter((option) => option.enabled)
    .map((option) => {
      const base = {
        id: option.id,
        label: option.label.trim() || "Other appeal",
        description: option.description.trim(),
        formId: option.form_id,
        appealId: null as number | null,
        until: null as Date | null,
      };
      if (option.require_ban && !viewer.isBanned) return { ...base, state: "not_banned" as const };
      const history = historyState(
        config,
        appeals.filter((appeal) => appeal.kind === "manual" && appeal.option?.id === option.id),
        now,
      );
      return history && history.state !== "resolved"
        ? { ...base, state: history.state, until: history.until, appealId: history.appealId }
        : { ...base, state: "appealable" as const };
    });

  return { cases: options, manual, custom, block: blockReason(config, appeals, now, viewer) };
}

function blockReason(
  config: AppealsConfig,
  appeals: AppealRecord[],
  now: Date,
  viewer: ViewerFacts & { userId: string },
): BlockReason | null {
  if (config.limits.blocked_users.includes(viewer.userId)) return { kind: "blocked" };
  if (viewer.isMember && viewer.memberRoleIds.some((id) => config.limits.blocked_roles.includes(id))) {
    return { kind: "blocked" };
  }
  const minAge = durationMs(config.limits.min_account_age);
  if (minAge > 0) {
    const oldEnough = new Date(viewer.accountCreatedAt.getTime() + minAge);
    if (oldEnough > now) return { kind: "account_too_new", until: oldEnough };
  }
  const open = appeals.filter((appeal) => OPEN_STATUSES.includes(appeal.status)).length;
  if (open >= config.limits.max_open_per_user) return { kind: "too_many_open", max: config.limits.max_open_per_user };
  return null;
}

/** Discord user ids encode their account's creation time. */
export function snowflakeDate(id: string): Date {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1_420_070_400_000n));
  } catch {
    return new Date(0);
  }
}
