import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { changelogUpdates } from "../../db/schema.js";
import { CHANGELOG_STATUSES, type ChangelogCommit, type ChangelogContent, type ChangelogStatus } from "./rules.js";

/** One stored update. `content` is null until Autopilot has written it. */
export type ChangelogRow = {
  id: number;
  slug: string;
  windowStart: number;
  windowEnd: number;
  commits: ChangelogCommit[];
  content: ChangelogContent | null;
  status: ChangelogStatus;
  model: string | null;
  generatedFor: string | null;
  generatedAt: number | null;
  generationError: string | null;
  editedBy: string | null;
  editedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ChangelogRowInput = Omit<ChangelogRow, "id">;
export type ChangelogRowPatch = Partial<Omit<ChangelogRow, "id" | "createdAt">>;

/** Storage behind the changelog service (SQLite here; an in-memory copy in the tests). */
export interface ChangelogStore {
  /** Every update, newest window first. */
  list(): Promise<ChangelogRow[]>;
  /** Published updates that have content, newest first. */
  listPublished(offset: number, limit: number): Promise<{ rows: ChangelogRow[]; total: number }>;
  get(id: number): Promise<ChangelogRow | null>;
  getBySlug(slug: string): Promise<ChangelogRow | null>;
  insert(row: ChangelogRowInput): Promise<ChangelogRow>;
  update(id: number, patch: ChangelogRowPatch): Promise<ChangelogRow | null>;
  delete(id: number): Promise<void>;
}

type Row = typeof changelogUpdates.$inferSelect;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(row: Row): ChangelogRow {
  return {
    id: row.id,
    slug: row.slug,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    commits: parseJson<ChangelogCommit[]>(row.commitsJson, []),
    content: parseJson<ChangelogContent | null>(row.contentJson, null),
    status: (CHANGELOG_STATUSES as readonly string[]).includes(row.status) ? (row.status as ChangelogStatus) : "draft",
    model: row.model ?? null,
    generatedFor: row.generatedFor ?? null,
    generatedAt: row.generatedAt ?? null,
    generationError: row.generationError ?? null,
    editedBy: row.editedBy ?? null,
    editedAt: row.editedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toColumns(patch: ChangelogRowPatch): Partial<typeof changelogUpdates.$inferInsert> {
  const out: Partial<typeof changelogUpdates.$inferInsert> = {};
  if (patch.slug !== undefined) out.slug = patch.slug;
  if (patch.windowStart !== undefined) out.windowStart = patch.windowStart;
  if (patch.windowEnd !== undefined) out.windowEnd = patch.windowEnd;
  if (patch.commits !== undefined) {
    out.commitsJson = JSON.stringify(patch.commits);
    out.commitShas = JSON.stringify(patch.commits.map((c) => c.sha));
    out.commitCount = patch.commits.length;
  }
  if (patch.content !== undefined) out.contentJson = patch.content ? JSON.stringify(patch.content) : null;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.generatedFor !== undefined) out.generatedFor = patch.generatedFor;
  if (patch.generatedAt !== undefined) out.generatedAt = patch.generatedAt;
  if (patch.generationError !== undefined) out.generationError = patch.generationError;
  if (patch.editedBy !== undefined) out.editedBy = patch.editedBy;
  if (patch.editedAt !== undefined) out.editedAt = patch.editedAt;
  if (patch.updatedAt !== undefined) out.updatedAt = patch.updatedAt;
  return out;
}

export const sqliteChangelogStore: ChangelogStore = {
  async list() {
    const rows = await getDb().select().from(changelogUpdates).orderBy(desc(changelogUpdates.windowEnd));
    return rows.map(toRow);
  },
  async listPublished(offset, limit) {
    const where = and(eq(changelogUpdates.status, "published"), isNotNull(changelogUpdates.contentJson));
    const [rows, totals] = await Promise.all([
      getDb().select().from(changelogUpdates).where(where).orderBy(desc(changelogUpdates.windowEnd)).limit(limit).offset(offset),
      getDb().select({ n: count() }).from(changelogUpdates).where(where),
    ]);
    return { rows: rows.map(toRow), total: totals[0]?.n ?? 0 };
  },
  async get(id) {
    const [row] = await getDb().select().from(changelogUpdates).where(eq(changelogUpdates.id, id)).limit(1);
    return row ? toRow(row) : null;
  },
  async getBySlug(slug) {
    const [row] = await getDb().select().from(changelogUpdates).where(eq(changelogUpdates.slug, slug)).limit(1);
    return row ? toRow(row) : null;
  },
  async insert(row) {
    const columns = toColumns(row);
    const [inserted] = await getDb()
      .insert(changelogUpdates)
      .values({
        ...columns,
        slug: row.slug,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        commitShas: columns.commitShas!,
        commitsJson: columns.commitsJson!,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
      .returning();
    return toRow(inserted!);
  },
  async update(id, patch) {
    const [row] = await getDb().update(changelogUpdates).set(toColumns(patch)).where(eq(changelogUpdates.id, id)).returning();
    return row ? toRow(row) : null;
  },
  async delete(id) {
    await getDb().delete(changelogUpdates).where(eq(changelogUpdates.id, id));
  },
};

/** In-memory store with the same behaviour, for tests and dry runs. */
export function createMemoryChangelogStore(initial: ChangelogRow[] = []): ChangelogStore & { rows: ChangelogRow[] } {
  const rows: ChangelogRow[] = initial.map((r) => ({ ...r }));
  let nextId = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  const byEnd = (list: ChangelogRow[]) => [...list].sort((a, b) => b.windowEnd - a.windowEnd);
  return {
    rows,
    async list() {
      return byEnd(rows).map((r) => ({ ...r }));
    },
    async listPublished(offset, limit) {
      const published = byEnd(rows.filter((r) => r.status === "published" && r.content));
      return { rows: published.slice(offset, offset + limit).map((r) => ({ ...r })), total: published.length };
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async getBySlug(slug) {
      const row = rows.find((r) => r.slug === slug);
      return row ? { ...row } : null;
    },
    async insert(input) {
      if (rows.some((r) => r.slug === input.slug)) throw new Error("UNIQUE constraint failed: changelog_updates.slug");
      const row = { ...input, id: nextId++ };
      rows.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return { ...row };
    },
    async delete(id) {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}
