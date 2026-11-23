import { getLogger } from "../logger.js";
import {
  CHANGELOG_STATUSES,
  ChangelogError,
  commitSetKey,
  commitTime,
  groupCommitsIntoWindows,
  isEmptyContent,
  isWindowClosed,
  parseChangelogContent,
  uniqueSlug,
  windowOptionsFromEnv,
  type ChangelogCommit,
  type ChangelogContent,
  type ChangelogStatus,
  type WindowOptions,
} from "./rules.js";
import type { ChangelogRow, ChangelogStore } from "./store.js";

const log = getLogger("changelog");

/**
 * The public changelog: finds new commits, closes release windows, has Autopilot write each window
 * once, and serves published updates to the website. Operators (platform superusers) can edit,
 * regenerate, hide, merge and split updates.
 */

export type ChangelogDeps = {
  store: ChangelogStore;
  fetchCommits(sinceMs: number | null): Promise<{ commits: ChangelogCommit[]; source: string }>;
  fillAreas(commits: ChangelogCommit[]): Promise<ChangelogCommit[]>;
  generate(input: { windowStart: number; windowEnd: number; commits: ChangelogCommit[] }): Promise<{ content: ChangelogContent; model: string }>;
  repoIsPublic(): boolean;
  repo: string;
  now?: () => number;
  windowOptions?: WindowOptions;
  /** How many windows a sync generates at most (the newest); older ones wait for "generate older".
   *  The default covers the whole history, so the page goes back to the first commit. */
  backfillLimit?: number;
};

export type PublicChangelogSection = ChangelogContent["sections"][number];

/** What the website shows. No commit messages, hashes, emails or file paths. */
export type PublicChangelogUpdate = {
  slug: string;
  title: string;
  summary: string;
  headline: string[];
  sections: PublicChangelogSection[];
  smallerImprovements: string[];
  /** The update's date: the end of its release window (ISO). */
  date: string;
  windowStart: string;
  changeCount: number;
  /** GitHub history for the window, only while the repo is public. */
  githubUrl: string | null;
};

export type AdminChangelogUpdate = {
  id: number;
  slug: string;
  windowStart: string;
  windowEnd: string;
  status: ChangelogStatus;
  content: ChangelogContent | null;
  model: string | null;
  generatedAt: string | null;
  generationError: string | null;
  /** True when the content no longer matches the commits (after a merge or split). */
  stale: boolean;
  editedBy: string | null;
  editedAt: string | null;
  commits: { sha: string; shortSha: string; date: string; subject: string; areas: string[] }[];
};

export type ChangelogSyncResult = {
  at: string;
  source: string | null;
  inserted: number;
  generated: number;
  failed: number;
  openWindow: { commits: number; start: string; end: string } | null;
  error: string | null;
};

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class ChangelogService {
  private readonly deps: Required<ChangelogDeps>;
  private syncing: Promise<ChangelogSyncResult> | null = null;
  private readonly generating = new Map<number, Promise<ChangelogRow>>();
  lastSync: ChangelogSyncResult | null = null;

  constructor(deps: ChangelogDeps) {
    this.deps = {
      now: () => Date.now(),
      windowOptions: windowOptionsFromEnv(),
      backfillLimit: 60,
      ...deps,
    };
  }

  // --- Public -------------------------------------------------------------------------------

  toPublic(row: ChangelogRow): PublicChangelogUpdate | null {
    if (row.status !== "published" || !row.content) return null;
    const c = row.content;
    // The day after the window ends, so a late-evening commit isn't cut off by time zones.
    const until = dayOf(row.windowEnd + 86_400_000);
    return {
      slug: row.slug,
      title: c.title,
      summary: c.summary,
      headline: c.headline,
      sections: c.sections,
      smallerImprovements: c.smallerImprovements,
      date: new Date(row.windowEnd).toISOString(),
      windowStart: new Date(row.windowStart).toISOString(),
      changeCount: row.commits.length,
      githubUrl: this.deps.repoIsPublic()
        ? `https://github.com/${this.deps.repo}/commits/main/?since=${dayOf(row.windowStart)}&until=${until}`
        : null,
    };
  }

  async listPublic(page: number, limit: number): Promise<{ updates: PublicChangelogUpdate[]; page: number; limit: number; total: number; hasMore: boolean }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 30);
    const safePage = Math.min(Math.max(Math.trunc(page) || 1, 1), 1000);
    const { rows, total } = await this.deps.store.listPublished((safePage - 1) * safeLimit, safeLimit);
    const updates = rows.map((r) => this.toPublic(r)).filter((u): u is PublicChangelogUpdate => u !== null);
    return { updates, page: safePage, limit: safeLimit, total, hasMore: safePage * safeLimit < total };
  }

  async getPublic(slug: string): Promise<PublicChangelogUpdate | null> {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return null;
    const row = await this.deps.store.getBySlug(slug);
    return row ? this.toPublic(row) : null;
  }

  // --- Operators ------------------------------------------------------------------------------

  toAdmin(row: ChangelogRow): AdminChangelogUpdate {
    return {
      id: row.id,
      slug: row.slug,
      windowStart: new Date(row.windowStart).toISOString(),
      windowEnd: new Date(row.windowEnd).toISOString(),
      status: row.status,
      content: row.content,
      model: row.model,
      generatedAt: iso(row.generatedAt),
      generationError: row.generationError,
      stale: Boolean(row.content) && row.generatedFor !== null && row.generatedFor !== commitSetKey(row.commits.map((c) => c.sha)),
      editedBy: row.editedBy,
      editedAt: iso(row.editedAt),
      commits: [...row.commits]
        .sort((a, b) => commitTime(a) - commitTime(b))
        .map((c) => ({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          date: c.date,
          subject: (c.message.split("\n")[0] ?? "").slice(0, 200),
          areas: c.areas ?? [],
        })),
    };
  }

  async listAdmin(): Promise<{ updates: AdminChangelogUpdate[]; lastSync: ChangelogSyncResult | null; windowOptions: WindowOptions }> {
    const rows = await this.deps.store.list();
    return { updates: rows.map((r) => this.toAdmin(r)), lastSync: this.lastSync, windowOptions: this.deps.windowOptions };
  }

  /**
   * Writes (or rewrites) one update. Idempotent: an update whose content was already generated from
   * exactly these commits is left alone unless `force` is set, and concurrent calls share one run.
   */
  generate(id: number, options: { force?: boolean; publish?: boolean } = {}): Promise<ChangelogRow> {
    const running = this.generating.get(id);
    if (running) return running;
    const job = this.runGenerate(id, options).finally(() => this.generating.delete(id));
    this.generating.set(id, job);
    return job;
  }

  private async runGenerate(id: number, options: { force?: boolean; publish?: boolean }): Promise<ChangelogRow> {
    const { store } = this.deps;
    const row = await store.get(id);
    if (!row) throw new ChangelogError("Update not found.");
    const key = commitSetKey(row.commits.map((c) => c.sha));
    if (!options.force && row.content && row.generatedFor === key) return row;

    let commits = row.commits;
    try {
      commits = await this.deps.fillAreas(row.commits);
    } catch (error) {
      log.warn(`Couldn't look up changed areas: ${error instanceof Error ? error.message : error}`);
    }
    let result: { content: ChangelogContent; model: string };
    try {
      result = await this.deps.generate({ windowStart: row.windowStart, windowEnd: row.windowEnd, commits });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.update(id, { commits, generationError: message.slice(0, 500), updatedAt: this.deps.now() });
      throw error;
    }
    const empty = isEmptyContent(result.content);
    let status = row.status;
    if (options.publish) status = "published";
    // Nothing user-facing in this window (chores only): keep it off the public page.
    if (empty && status === "published") status = "hidden";
    const updated = await store.update(id, {
      commits,
      content: result.content,
      model: result.model,
      generatedFor: key,
      generatedAt: this.deps.now(),
      generationError: null,
      editedBy: null,
      editedAt: null,
      status,
      updatedAt: this.deps.now(),
    });
    log.info(`Generated ${row.slug} (${commits.length} commits${empty ? ", nothing user-facing" : ""}).`);
    return updated!;
  }

  /** Looks for new commits, stores closed windows and writes the newest ones. Single-flight. */
  sync(): Promise<ChangelogSyncResult> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync()
      .then((result) => {
        this.lastSync = result;
        return result;
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  private async runSync(): Promise<ChangelogSyncResult> {
    const { store, windowOptions, backfillLimit } = this.deps;
    const now = this.deps.now();
    const result: ChangelogSyncResult = { at: new Date(now).toISOString(), source: null, inserted: 0, generated: 0, failed: 0, openWindow: null, error: null };

    const rows = await store.list();
    const known = new Set(rows.flatMap((r) => r.commits.map((c) => c.sha)));
    const latestEnd = rows.reduce((max, r) => Math.max(max, r.windowEnd), 0);

    let fresh: ChangelogCommit[] = [];
    try {
      // A little overlap, so commits whose author date is slightly out of order aren't missed.
      const fetched = await this.deps.fetchCommits(latestEnd ? latestEnd - 86_400_000 : null);
      result.source = fetched.source;
      fresh = fetched.commits.filter((c) => !known.has(c.sha) && commitTime(c) > latestEnd);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      log.warn(`Couldn't read commits: ${result.error}`);
    }

    const windows = groupCommitsIntoWindows(fresh, windowOptions);
    const taken = new Set(rows.map((r) => r.slug));
    for (const [index, window] of windows.entries()) {
      if (!isWindowClosed(window, index === windows.length - 1, now, windowOptions)) {
        result.openWindow = { commits: window.commits.length, start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() };
        continue;
      }
      const slug = uniqueSlug(window.end, (s) => taken.has(s));
      taken.add(slug);
      await store.insert({
        slug,
        windowStart: window.start,
        windowEnd: window.end,
        commits: window.commits,
        content: null,
        status: "published",
        model: null,
        generatedFor: null,
        generatedAt: null,
        generationError: null,
        editedBy: null,
        editedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      result.inserted++;
    }

    // Write the newest waiting windows; anything older becomes a draft for "generate older", so a
    // backfill (or a long outage) never turns into dozens of AI calls.
    const waiting = (await store.list()).filter((r) => r.status === "published" && !r.content);
    for (const row of waiting.slice(backfillLimit)) {
      await store.update(row.id, { status: "draft", updatedAt: now });
    }
    for (const row of waiting.slice(0, backfillLimit)) {
      try {
        await this.generate(row.id);
        result.generated++;
      } catch (error) {
        result.failed++;
        log.warn(`Couldn't generate ${row.slug}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return result;
  }

  /** Writes and publishes the newest `count` drafts that have never been generated. */
  async generateOlder(count: number): Promise<{ generated: number; failed: number; remaining: number }> {
    const limit = Math.min(Math.max(Math.trunc(count) || 3, 1), 5);
    const drafts = (await this.deps.store.list()).filter((r) => r.status === "draft" && !r.content);
    let generated = 0;
    let failed = 0;
    for (const row of drafts.slice(0, limit)) {
      try {
        await this.generate(row.id, { publish: true });
        generated++;
      } catch (error) {
        failed++;
        log.warn(`Couldn't generate ${row.slug}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { generated, failed, remaining: Math.max(drafts.length - limit, 0) + failed };
  }

  /** An operator's edit of the text and/or status. */
  async edit(id: number, input: { content?: unknown; status?: unknown }, actorId: string): Promise<ChangelogRow> {
    const row = await this.deps.store.get(id);
    if (!row) throw new ChangelogError("Update not found.");
    const patch: Partial<ChangelogRow> = { updatedAt: this.deps.now() };
    if (input.content !== undefined) {
      patch.content = parseChangelogContent(input.content);
      patch.editedBy = actorId;
      patch.editedAt = this.deps.now();
    }
    if (input.status !== undefined) {
      if (typeof input.status !== "string" || !(CHANGELOG_STATUSES as readonly string[]).includes(input.status)) {
        throw new ChangelogError("Status must be published, draft or hidden.");
      }
      if (input.status === "published" && !(patch.content ?? row.content)) {
        throw new ChangelogError("Generate this update before publishing it.");
      }
      patch.status = input.status as ChangelogStatus;
    }
    return (await this.deps.store.update(id, patch))!;
  }

  /**
   * Merges adjacent updates into one (the newest keeps its id and link). The merged update is a draft
   * until it's regenerated and published.
   */
  async merge(ids: number[], actorId: string): Promise<ChangelogRow> {
    const unique = [...new Set(ids)];
    if (unique.length < 2) throw new ChangelogError("Pick at least two updates to merge.");
    const all = await this.deps.store.list(); // newest first
    const positions = unique.map((id) => all.findIndex((r) => r.id === id));
    if (positions.some((p) => p < 0)) throw new ChangelogError("Update not found.");
    positions.sort((a, b) => a - b);
    if (positions.at(-1)! - positions[0]! !== positions.length - 1) {
      throw new ChangelogError("Only neighbouring updates can be merged.");
    }
    const group = positions.map((p) => all[p]!);
    const [keep, ...rest] = group;
    const commits = group.flatMap((r) => r.commits).sort((a, b) => commitTime(a) - commitTime(b));
    for (const row of rest) await this.deps.store.delete(row.id);
    const now = this.deps.now();
    const merged = await this.deps.store.update(keep!.id, {
      commits,
      windowStart: Math.min(...group.map((r) => r.windowStart)),
      windowEnd: Math.max(...group.map((r) => r.windowEnd)),
      content: null,
      generatedFor: null,
      generatedAt: null,
      status: "draft",
      editedBy: actorId,
      editedAt: now,
      updatedAt: now,
    });
    log.info(`${actorId} merged ${group.map((r) => r.slug).join(", ")} into ${keep!.slug}.`);
    return merged!;
  }

  /**
   * Splits an update before the given commit: earlier commits move to a new update, the rest stay
   * (keeping the id and link). Both are drafts until regenerated.
   */
  async split(id: number, atSha: string, actorId: string): Promise<{ earlier: ChangelogRow; later: ChangelogRow }> {
    const row = await this.deps.store.get(id);
    if (!row) throw new ChangelogError("Update not found.");
    const commits = [...row.commits].sort((a, b) => commitTime(a) - commitTime(b));
    const at = commits.findIndex((c) => c.sha === atSha || (atSha.length >= 7 && c.sha.startsWith(atSha)));
    if (at <= 0) throw new ChangelogError("Pick a commit after the first one to split at.");
    const before = commits.slice(0, at);
    const after = commits.slice(at);
    const now = this.deps.now();
    const taken = new Set((await this.deps.store.list()).map((r) => r.slug));
    const fresh = { content: null, generatedFor: null, generatedAt: null, generationError: null, status: "draft" as const, model: null };
    const later = await this.deps.store.update(id, {
      ...fresh,
      commits: after,
      windowStart: commitTime(after[0]!),
      editedBy: actorId,
      editedAt: now,
      updatedAt: now,
    });
    const earlierEnd = commitTime(before.at(-1)!);
    const earlier = await this.deps.store.insert({
      ...fresh,
      slug: uniqueSlug(earlierEnd, (s) => taken.has(s)),
      windowStart: commitTime(before[0]!),
      windowEnd: earlierEnd,
      commits: before,
      editedBy: actorId,
      editedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    log.info(`${actorId} split ${row.slug} into ${earlier.slug} and ${later!.slug}.`);
    return { earlier, later: later! };
  }
}

let service: ChangelogService | null = null;

/** The bot's changelog service (SQLite, GitHub with local git fallback, OpenAI). */
export async function getChangelogService(): Promise<ChangelogService> {
  if (service) return service;
  const [{ sqliteChangelogStore }, commits, { generateChangelogContent }] = await Promise.all([
    import("./store.js"),
    import("./commits.js"),
    import("./generate.js"),
  ]);
  // Learn whether the repo is public (for "View on GitHub" links); cached for six hours after.
  void commits.checkRepoAccess().catch(() => undefined);
  service ??= new ChangelogService({
    store: sqliteChangelogStore,
    fetchCommits: commits.fetchChangelogCommits,
    fillAreas: commits.fillCommitAreas,
    generate: (input) => generateChangelogContent(input),
    repoIsPublic: commits.knownRepoIsPublic,
    repo: commits.CHANGELOG_REPO,
  });
  return service;
}

/** Whether this process runs the scheduled sync: production by default, CHANGELOG_SYNC to override. */
export function changelogSyncEnabled(env: NodeJS.ProcessEnv = process.env, dreamlinerEnv: string): boolean {
  const flag = env.CHANGELOG_SYNC?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return dreamlinerEnv === "prod" && Boolean(env.OPENAI_API_KEY?.trim());
}
