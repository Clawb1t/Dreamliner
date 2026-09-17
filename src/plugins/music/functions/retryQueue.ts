import type { Track } from "lavalink-client";

/**
 * Backup plan for a track that was just played immediately (not queued behind something else).
 * YouTube's anti-bot wall is intermittent even with the PO-token bypass (works for some videos,
 * not others), and SoundCloud occasionally 404s on an individual upload - rather than surfacing
 * either as a dead end, events.ts's trackError handler works through this per-guild plan
 * automatically: other results from the original search first, then a fresh SoundCloud search
 * for the same query as a last resort (a different source entirely, since a source-wide block
 * won't be fixed by trying another result from that same source).
 */
type RetryPlan = {
  query: string;
  requesterId: string;
  candidates: Track[];
  /** True once the SoundCloud fallback search has been attempted, so we only try it once. */
  triedFallbackSource: boolean;
};

const plans = new Map<string, RetryPlan>();

const MAX_CANDIDATES = 4;

export function startRetryPlan(guildId: string, query: string, requesterId: string, candidates: Track[]): void {
  plans.set(guildId, { query, requesterId, candidates: candidates.slice(0, MAX_CANDIDATES), triedFallbackSource: false });
}

export function nextCandidate(guildId: string): Track | null {
  const plan = plans.get(guildId);
  if (!plan || plan.candidates.length === 0) return null;
  const [next, ...rest] = plan.candidates;
  plan.candidates = rest;
  return next ?? null;
}

/** Consumes the plan's fallback-source attempt (returns the query/requester to search with a
 *  different source, or null if there's no active plan or it's already been used). */
export function takeFallbackSourceAttempt(guildId: string): { query: string; requesterId: string } | null {
  const plan = plans.get(guildId);
  if (!plan || plan.triedFallbackSource) return null;
  plan.triedFallbackSource = true;
  return { query: plan.query, requesterId: plan.requesterId };
}

export function clearRetryPlan(guildId: string): void {
  plans.delete(guildId);
}
