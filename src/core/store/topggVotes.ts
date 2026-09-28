import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { storeVoteSync } from "../../db/schema.js";
import { getLogger } from "../logger.js";
import { recordVote } from "./credits.js";

/**
 * Imports Dreamliner's top.gg vote history (API v1) so votes the webhook never delivered, including
 * every vote from before store credits existed, can be claimed on the account page.
 *
 * Needs `TOPGG_API_TOKEN`: a v1 token from the top.gg dashboard (Integrations & API). The first sync
 * reads the last year (the most top.gg allows); later syncs continue from the newest vote seen.
 */

const log = getLogger("store");
const API = "https://top.gg/api/v1";
const DAY_MS = 86_400_000;
/** top.gg rejects a start date more than a year back; stay a little inside it. */
const HISTORY_WINDOW_MS = 364 * DAY_MS;
/** Re-read a little before the newest vote seen, so a vote landing during a sync is never skipped. */
const OVERLAP_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_PAGES = 2000;
const SYNC_ROW_ID = 1;

type HistoryPage = {
  cursor?: string | null;
  data?: Array<{ platform_id?: string; created_at?: string; weight?: number }>;
};

export function isVoteHistoryConfigured(): boolean {
  return Boolean(process.env.TOPGG_API_TOKEN?.trim());
}

function syncState() {
  return getDb().select().from(storeVoteSync).where(eq(storeVoteSync.id, SYNC_ROW_ID)).get();
}

function saveState(patch: Partial<typeof storeVoteSync.$inferInsert>): void {
  getDb()
    .insert(storeVoteSync)
    .values({ id: SYNC_ROW_ID, ...patch })
    .onConflictDoUpdate({ target: storeVoteSync.id, set: patch })
    .run();
}

export type VoteSyncResult =
  | { ok: true; imported: number; skipped?: "recent" | "not_configured" }
  | { ok: false; error: string };

let inFlight: Promise<VoteSyncResult> | null = null;

/** Syncs new votes from top.gg. Concurrent callers share one run; runs closer than a minute apart
 *  are skipped (the data can't have moved much). */
export function syncVoteHistory(options: { force?: boolean } = {}): Promise<VoteSyncResult> {
  if (!isVoteHistoryConfigured()) return Promise.resolve({ ok: true, imported: 0, skipped: "not_configured" });
  if (inFlight) return inFlight;
  const last = syncState()?.lastSyncedAt?.getTime() ?? 0;
  if (!options.force && Date.now() - last < MIN_INTERVAL_MS) {
    return Promise.resolve({ ok: true, imported: 0, skipped: "recent" });
  }
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<VoteSyncResult> {
  const token = process.env.TOPGG_API_TOKEN!.trim();
  const state = syncState();
  const floor = Date.now() - HISTORY_WINDOW_MS;
  const start = Math.max(floor, (state?.lastVoteAt?.getTime() ?? floor) - OVERLAP_MS);

  let cursor: string | null = null;
  let imported = 0;
  let newest = state?.lastVoteAt?.getTime() ?? 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = cursor ? `cursor=${encodeURIComponent(cursor)}` : `startDate=${encodeURIComponent(new Date(start).toISOString())}`;
      const res = await fetch(`${API}/projects/@me/votes?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { "retry-after"?: number };
        throw new Error(`top.gg rate limited the vote sync (retry in ${body["retry-after"] ?? "?"}s)`);
      }
      if (!res.ok) throw new Error(`top.gg returned HTTP ${res.status} for vote history`);

      const body = (await res.json()) as HistoryPage;
      const votes = body.data ?? [];
      if (votes.length === 0) break;
      for (const vote of votes) {
        const at = vote.created_at ? new Date(vote.created_at) : null;
        if (!vote.platform_id || !at || !Number.isFinite(at.getTime())) continue;
        recordVote({ userId: vote.platform_id, votedAt: at, source: "history", weight: vote.weight ?? 1 });
        imported++;
        newest = Math.max(newest, at.getTime());
      }
      if (!body.cursor) break;
      cursor = body.cursor;
    }
    saveState({ lastVoteAt: newest ? new Date(newest) : null, lastSyncedAt: new Date(), lastError: null });
    return { ok: true, imported };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep progress made before the failure; the next run carries on from there.
    saveState({ lastVoteAt: newest ? new Date(newest) : (state?.lastVoteAt ?? null), lastSyncedAt: new Date(), lastError: message });
    log.warn(`[store] Vote history sync failed: ${message}`);
    return { ok: false, error: message };
  }
}
