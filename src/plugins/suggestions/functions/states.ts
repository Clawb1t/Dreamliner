import type { SuggestionStatus } from "../constants.js";

/**
 * One flat "where is this suggestion at" value, for the dashboard's filters, stats and "By status"
 * sort. The bot stores two columns (status + display_status); this folds them together:
 * - `pending`: still in the review queue (status awaiting_review)
 * - `none`: approved and posted, but staff haven't given it a status yet (display_status none)
 * - `considered` / `progress` / `implemented` / `no`: the status staff marked on an approved one
 * - `denied`: denied or deleted (status denied)
 */
export const SUGGESTION_STATES = ["pending", "none", "considered", "progress", "implemented", "no", "denied"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

export const SUGGESTION_SORTS = ["newest", "oldest", "top", "controversial", "pending_oldest", "status"] as const;
export type SuggestionSort = (typeof SUGGESTION_SORTS)[number];

export function isSuggestionState(value: unknown): value is SuggestionState {
  return typeof value === "string" && (SUGGESTION_STATES as readonly string[]).includes(value);
}

export function isSuggestionSort(value: unknown): value is SuggestionSort {
  return typeof value === "string" && (SUGGESTION_SORTS as readonly string[]).includes(value);
}

export function suggestionState(status: string, displayStatus: string): SuggestionState {
  if (status === "awaiting_review") return "pending";
  if (status === "denied") return "denied";
  return isSuggestionState(displayStatus) && displayStatus !== "pending" && displayStatus !== "denied" ? displayStatus : "none";
}

/** The stored columns a state filter matches. */
export function stateColumns(state: SuggestionState): { status: SuggestionStatus; displayStatus?: string } {
  if (state === "pending") return { status: "awaiting_review" };
  if (state === "denied") return { status: "denied" };
  return { status: "approved", displayStatus: state };
}

/** "Duplicate of #12", with the staff reason after it when there is one. */
export function duplicateReason(of: number, reason?: string | null): string {
  const trimmed = reason?.trim();
  return trimmed ? `Duplicate of #${of}: ${trimmed}` : `Duplicate of #${of}`;
}

/** Suggestion ids from a bulk request: positive integers, de-duplicated, at most `max`. */
export function parseBulkIds(raw: unknown, max = 50): number[] {
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const value of raw) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
    if (ids.length >= max) break;
  }
  return ids;
}
