import type { AutomodRuleId } from "../../../config/schemas/automod.js";
import type { IncidentSeverity } from "../../../config/schemas/incidentResponse.js";

/**
 * How much risk each Automod rule contributes to an incident when it hits. Rules that are
 * themselves strong evidence of malicious intent (slurs, known-malware links, scam images)
 * weigh far more than noisy spam-cadence rules — those only really matter once several of them
 * pile up, or combine with a signal from another plugin entirely (see `CORRELATION_BONUS`).
 */
export const AUTOMOD_RULE_WEIGHTS: Partial<Record<AutomodRuleId, number>> = {
  slurs: 6,
  image_scan: 6,
  domain_intel: 7,
  invites: 5,
  custom_filter: 3,
  links: 3,
  mass_mentions: 3,
  everyone_here: 3,
  zalgo: 2,
  profanity: 2,
  excessive_swearing: 2,
  spam: 2,
  emoji_spam: 2,
  duplicate: 2,
  copypasta: 2,
  sticker_gif_spam: 2,
  attachment_spam: 2,
  excessive_caps: 1,
  newline_spam: 1,
  wall_of_text: 1,
  repeated_chars: 1,
};
const DEFAULT_AUTOMOD_WEIGHT = 2;

export function weightForAutomodRule(ruleId: string): number {
  return AUTOMOD_RULE_WEIGHTS[ruleId as AutomodRuleId] ?? DEFAULT_AUTOMOD_WEIGHT;
}

/** A raid burst is serious enough on its own to reach High severity unassisted. */
export const RAID_SIGNAL_WEIGHT = 20;

/** A Scam Protect trip (posting in the honeypot channel) is unambiguous. */
export const SCAM_PROTECT_SIGNAL_WEIGHT = 9;

/** Impersonation Detection's 0-100 match score scaled down to a 1-10 weight. */
export function weightForImpersonationScore(score: number): number {
  return Math.min(10, Math.max(1, Math.round(score / 10)));
}

export const NUKE_SIGNAL_WEIGHTS = {
  mass_channel_delete: 15,
  mass_role_delete: 15,
  mass_ban: 18,
  mass_kick: 12,
  webhook_burst: 10,
  admin_grant_new_account: 14,
} as const;
export type NukeSignalType = keyof typeof NUKE_SIGNAL_WEIGHTS;

/** Added once an incident's signals span 2+ distinct sources — the whole point of correlation
 * is that combined evidence from different systems is worse news than any one alone. */
export const CORRELATION_BONUS = 5;

export type IncidentThresholds = { medium: number; high: number; critical: number };

export function severityFromScore(score: number, thresholds: IncidentThresholds): IncidentSeverity {
  if (score >= thresholds.critical) return "critical";
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  return "low";
}

export const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function isSeverityIncrease(next: IncidentSeverity, previous: IncidentSeverity | null): boolean {
  if (!previous) return true;
  return SEVERITY_RANK[next] > SEVERITY_RANK[previous];
}

/**
 * Recomputes an incident's total risk score fresh from its full signal list every time
 * (rather than incrementally bumping a stored counter) so there's no drift between what's
 * displayed and what's actually stored — the source of truth is always the signal rows.
 */
export function computeIncidentScore(signals: { weight: number; source: string }[]): {
  riskScore: number;
  sourceCount: number;
} {
  const distinctSources = new Set(signals.map((s) => s.source));
  const base = signals.reduce((sum, s) => sum + s.weight, 0);
  const bonus = distinctSources.size >= 2 ? CORRELATION_BONUS : 0;
  return { riskScore: base + bonus, sourceCount: distinctSources.size };
}
