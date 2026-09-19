import { and, desc, eq, isNull, lte, gte, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { siteBannerAnnouncements } from "../db/schema.js";

/** Purely presentational on the website — each drives a different color/icon treatment for the
 *  banner bar. Not enforced beyond "is one of these" so the website's styling stays in sync. */
export const BANNER_KINDS = ["info", "success", "warning", "critical", "promo", "maintenance"] as const;
export type BannerKind = (typeof BANNER_KINDS)[number];

export function isBannerKind(value: unknown): value is BannerKind {
  return typeof value === "string" && (BANNER_KINDS as readonly string[]).includes(value);
}

export type BannerAnnouncement = {
  id: number;
  kind: BannerKind;
  title: string;
  body: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  dismissible: boolean;
  priority: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function toBanner(row: typeof siteBannerAnnouncements.$inferSelect): BannerAnnouncement {
  return {
    id: row.id,
    kind: isBannerKind(row.kind) ? row.kind : "info",
    title: row.title,
    body: row.body ?? null,
    ctaLabel: row.ctaLabel ?? null,
    ctaUrl: row.ctaUrl ?? null,
    dismissible: row.dismissible,
    priority: row.priority,
    enabled: row.enabled,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class BannerAnnouncementError extends Error {}

/** Every banner, enabled or not, live or scheduled: for the superuser dashboard's list. */
export async function listAdminBanners(): Promise<BannerAnnouncement[]> {
  const rows = await getDb()
    .select()
    .from(siteBannerAnnouncements)
    .orderBy(desc(siteBannerAnnouncements.priority), desc(siteBannerAnnouncements.createdAt))
    .all();
  return rows.map(toBanner);
}

/** Enabled banners whose schedule window (if any) currently covers "now" — what the home page
 *  actually renders. Ordered highest-priority first, then newest first. */
export async function listActiveBanners(): Promise<BannerAnnouncement[]> {
  const now = new Date();
  const rows = await getDb()
    .select()
    .from(siteBannerAnnouncements)
    .where(
      and(
        eq(siteBannerAnnouncements.enabled, true),
        or(isNull(siteBannerAnnouncements.startsAt), lte(siteBannerAnnouncements.startsAt, now)),
        or(isNull(siteBannerAnnouncements.endsAt), gte(siteBannerAnnouncements.endsAt, now)),
      ),
    )
    .orderBy(desc(siteBannerAnnouncements.priority), desc(siteBannerAnnouncements.createdAt))
    .all();
  return rows.map(toBanner);
}

async function getBannerById(id: number): Promise<BannerAnnouncement | null> {
  const row = await getDb().select().from(siteBannerAnnouncements).where(eq(siteBannerAnnouncements.id, id)).get();
  return row ? toBanner(row) : null;
}

function parseDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw new BannerAnnouncementError(`${field} is not a valid date.`);
  return date;
}

function requireCtaPair(ctaLabel: string | null, ctaUrl: string | null): void {
  if (Boolean(ctaLabel) !== Boolean(ctaUrl)) {
    throw new BannerAnnouncementError("ctaLabel and ctaUrl must be set together, or both left empty.");
  }
  if (ctaUrl) {
    try {
      new URL(ctaUrl);
    } catch {
      throw new BannerAnnouncementError("ctaUrl must be a valid absolute URL.");
    }
  }
}

export type CreateBannerInput = {
  kind: unknown;
  title: unknown;
  body: unknown;
  ctaLabel: unknown;
  ctaUrl: unknown;
  dismissible: unknown;
  priority: unknown;
  enabled: unknown;
  startsAt: unknown;
  endsAt: unknown;
  createdBy: string;
};

export async function createAdminBanner(input: CreateBannerInput): Promise<BannerAnnouncement> {
  if (!isBannerKind(input.kind)) {
    throw new BannerAnnouncementError(`kind must be one of: ${BANNER_KINDS.join(", ")}.`);
  }
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 150) : "";
  if (!title) throw new BannerAnnouncementError("title is required.");
  const body = typeof input.body === "string" ? input.body.trim().slice(0, 500) || null : null;
  const ctaLabel = typeof input.ctaLabel === "string" ? input.ctaLabel.trim().slice(0, 40) || null : null;
  const ctaUrl = typeof input.ctaUrl === "string" ? input.ctaUrl.trim() || null : null;
  requireCtaPair(ctaLabel, ctaUrl);

  const startsAt = parseDate(input.startsAt, "startsAt") ?? null;
  const endsAt = parseDate(input.endsAt, "endsAt") ?? null;
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw new BannerAnnouncementError("endsAt must be after startsAt.");
  }

  const now = new Date();
  const inserted = await getDb()
    .insert(siteBannerAnnouncements)
    .values({
      kind: input.kind,
      title,
      body,
      ctaLabel,
      ctaUrl,
      dismissible: typeof input.dismissible === "boolean" ? input.dismissible : true,
      priority: Number.isFinite(Number(input.priority)) ? Math.round(Number(input.priority)) : 0,
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      startsAt,
      endsAt,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  return toBanner(inserted);
}

export type UpdateBannerInput = Partial<{
  kind: unknown;
  title: unknown;
  body: unknown;
  ctaLabel: unknown;
  ctaUrl: unknown;
  dismissible: unknown;
  priority: unknown;
  enabled: unknown;
  startsAt: unknown;
  endsAt: unknown;
}>;

export async function updateAdminBanner(id: number, input: UpdateBannerInput): Promise<BannerAnnouncement> {
  const existing = await getBannerById(id);
  if (!existing) throw new BannerAnnouncementError("That banner doesn't exist.");

  const patch: Partial<typeof siteBannerAnnouncements.$inferInsert> = { updatedAt: new Date() };

  if (input.kind !== undefined) {
    if (!isBannerKind(input.kind)) throw new BannerAnnouncementError(`kind must be one of: ${BANNER_KINDS.join(", ")}.`);
    patch.kind = input.kind;
  }
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 150) : "";
    if (!title) throw new BannerAnnouncementError("title must not be empty.");
    patch.title = title;
  }
  if (input.body !== undefined) {
    patch.body = typeof input.body === "string" ? input.body.trim().slice(0, 500) || null : null;
  }

  const nextCtaLabel =
    input.ctaLabel !== undefined
      ? typeof input.ctaLabel === "string"
        ? input.ctaLabel.trim().slice(0, 40) || null
        : null
      : existing.ctaLabel;
  const nextCtaUrl =
    input.ctaUrl !== undefined ? (typeof input.ctaUrl === "string" ? input.ctaUrl.trim() || null : null) : existing.ctaUrl;
  if (input.ctaLabel !== undefined || input.ctaUrl !== undefined) {
    requireCtaPair(nextCtaLabel, nextCtaUrl);
    patch.ctaLabel = nextCtaLabel;
    patch.ctaUrl = nextCtaUrl;
  }

  if (input.dismissible !== undefined) {
    if (typeof input.dismissible !== "boolean") throw new BannerAnnouncementError("dismissible must be a boolean.");
    patch.dismissible = input.dismissible;
  }
  if (input.priority !== undefined) {
    const priority = Number(input.priority);
    if (!Number.isFinite(priority)) throw new BannerAnnouncementError("priority must be a number.");
    patch.priority = Math.round(priority);
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new BannerAnnouncementError("enabled must be a boolean.");
    patch.enabled = input.enabled;
  }

  const nextStartsAt = input.startsAt !== undefined ? parseDate(input.startsAt, "startsAt") ?? null : existing.startsAt ? new Date(existing.startsAt) : null;
  const nextEndsAt = input.endsAt !== undefined ? parseDate(input.endsAt, "endsAt") ?? null : existing.endsAt ? new Date(existing.endsAt) : null;
  if (nextStartsAt && nextEndsAt && nextStartsAt.getTime() >= nextEndsAt.getTime()) {
    throw new BannerAnnouncementError("endsAt must be after startsAt.");
  }
  if (input.startsAt !== undefined) patch.startsAt = nextStartsAt;
  if (input.endsAt !== undefined) patch.endsAt = nextEndsAt;

  const updated = await getDb()
    .update(siteBannerAnnouncements)
    .set(patch)
    .where(eq(siteBannerAnnouncements.id, id))
    .returning()
    .get();
  return toBanner(updated);
}

export async function deleteAdminBanner(id: number): Promise<boolean> {
  const deleted = await getDb()
    .delete(siteBannerAnnouncements)
    .where(eq(siteBannerAnnouncements.id, id))
    .returning()
    .get();
  return Boolean(deleted);
}
