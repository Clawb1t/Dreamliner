import { isDreamlinerOneActive } from "../../../bridge/dreamlinerOne.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { DAY_MS } from "./config.js";

/**
 * Free core, Dreamliner One extras. Config validation never rejects a One-only value (the schema
 * allows One's limits); without One the runtime just ignores what's over the free limits.
 */
export type TeamLimits = { ranks: number; shiftTypes: number; checklist: number; historyDays: number | null };

export const FREE_LIMITS: TeamLimits = { ranks: 10, shiftTypes: 3, checklist: 10, historyDays: 90 };
export const ONE_LIMITS: TeamLimits = { ranks: 25, shiftTypes: 15, checklist: 40, historyDays: null };

/** How long data is kept regardless of the history window. */
export const FREE_RETENTION_DAYS = 400;
export const ONE_RETENTION_DAYS = 3 * 365;

export function teamLimits(one: boolean): TeamLimits {
  return one ? ONE_LIMITS : FREE_LIMITS;
}

export function retentionDays(one: boolean): number {
  return one ? ONE_RETENTION_DAYS : FREE_RETENTION_DAYS;
}

/** The oldest timestamp commands and the dashboard show, or null for no limit. */
export function historyCutoff(one: boolean, now = Date.now()): Date | null {
  const days = teamLimits(one).historyDays;
  return days === null ? null : new Date(now - days * DAY_MS);
}

/** The config the runtime actually uses: lists trimmed to the plan's limits, One-only switches off without One. */
export function applyOneGate(config: TeamControlConfig, one: boolean): TeamControlConfig {
  const limits = teamLimits(one);
  const ranks = config.ranks.slice(0, limits.ranks);
  const rankIds = new Set(ranks.map((rank) => rank.id));
  return {
    ...config,
    ranks,
    shifts: {
      ...config.shifts,
      types: config.shifts.types.slice(0, limits.shiftTypes).map((type) => ({ ...type, rank_ids: type.rank_ids.filter((id) => rankIds.has(id)) })),
    },
    activity: {
      ...config.activity,
      points_mode: one && config.activity.points_mode,
      scheduled_reports: one && config.activity.scheduled_reports,
    },
    onboarding: {
      ...config.onboarding,
      checklist: config.onboarding.checklist.slice(0, limits.checklist),
      trial_rank_id: config.onboarding.trial_rank_id && rankIds.has(config.onboarding.trial_rank_id) ? config.onboarding.trial_rank_id : null,
    },
  };
}

// One status is checked on every command and sweep; remember it for 10 minutes per guild
// (bounded, oldest dropped first).
const ONE_TTL_MS = 10 * 60_000;
const ONE_CACHE_MAX = 500;
const oneCache = new Map<string, { at: number; active: boolean }>();

export async function isTeamOneActive(guildId: string): Promise<boolean> {
  const hit = oneCache.get(guildId);
  if (hit && Date.now() - hit.at < ONE_TTL_MS) return hit.active;
  const active = await isDreamlinerOneActive(guildId).catch(() => false);
  oneCache.delete(guildId);
  oneCache.set(guildId, { at: Date.now(), active });
  while (oneCache.size > ONE_CACHE_MAX) oneCache.delete(oneCache.keys().next().value!);
  return active;
}

export function forgetOneStatus(guildId: string): void {
  oneCache.delete(guildId);
}
