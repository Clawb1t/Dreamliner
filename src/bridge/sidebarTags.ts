import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sidebarTags } from "../db/schema.js";
import {
  parseSidebarTagCreate,
  parseSidebarTagPatch,
  selectActiveSidebarTags,
  SIDEBAR_TAG_ICONS,
  SIDEBAR_TAG_KINDS,
  SIDEBAR_TAG_STYLES,
  SidebarTagError,
  type SidebarTagIcon,
  type SidebarTagKind,
  type SidebarTagStyle,
  type SidebarTagValues,
} from "./sidebarTagRules.js";

/** Superuser-managed tags on the website's dashboard sidebar (rules in sidebarTagRules.ts). */

export { SidebarTagError };

export type SidebarTag = {
  id: number;
  target: string;
  kind: SidebarTagKind;
  label: string;
  color: string;
  textColor: string | null;
  icon: SidebarTagIcon | null;
  style: SidebarTagStyle;
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
  sort: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** What every dashboard visitor gets: only what the sidebar draws. */
export type PublicSidebarTag = Pick<SidebarTag, "id" | "target" | "kind" | "label" | "color" | "textColor" | "icon" | "style" | "endsAt">;

type Row = typeof sidebarTags.$inferSelect;

function oneOf<T extends string>(list: readonly T[], value: string | null, fallback: T): T {
  return value != null && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toTag(row: Row): SidebarTag {
  return {
    id: row.id,
    target: row.target,
    kind: oneOf(SIDEBAR_TAG_KINDS, row.kind, "custom"),
    label: row.label,
    color: row.color,
    textColor: row.textColor ?? null,
    icon: row.icon && (SIDEBAR_TAG_ICONS as readonly string[]).includes(row.icon) ? (row.icon as SidebarTagIcon) : null,
    style: oneOf(SIDEBAR_TAG_STYLES, row.style, "solid"),
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    enabled: row.enabled,
    sort: row.sort,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toValues(row: Row): SidebarTagValues {
  const tag = toTag(row);
  return {
    target: tag.target,
    kind: tag.kind,
    label: tag.label,
    color: tag.color,
    textColor: tag.textColor,
    icon: tag.icon,
    style: tag.style,
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    enabled: tag.enabled,
    sort: tag.sort,
  };
}

export async function listAdminSidebarTags(): Promise<SidebarTag[]> {
  const rows = await getDb().select().from(sidebarTags).orderBy(asc(sidebarTags.target), asc(sidebarTags.sort), asc(sidebarTags.id)).all();
  return rows.map(toTag);
}

/** Live tags for the sidebar right now, at most two per item. */
export async function listActiveSidebarTags(now = new Date()): Promise<PublicSidebarTag[]> {
  const rows = await getDb().select().from(sidebarTags).where(eq(sidebarTags.enabled, true)).all();
  return selectActiveSidebarTags(rows, now).map((row) => {
    const tag = toTag(row);
    return {
      id: tag.id,
      target: tag.target,
      kind: tag.kind,
      label: tag.label,
      color: tag.color,
      textColor: tag.textColor,
      icon: tag.icon,
      style: tag.style,
      endsAt: tag.endsAt,
    };
  });
}

export async function createAdminSidebarTag(input: unknown, createdBy: string): Promise<SidebarTag> {
  const values = parseSidebarTagCreate(input);
  const now = new Date();
  const inserted = await getDb()
    .insert(sidebarTags)
    .values({ ...values, createdBy, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return toTag(inserted);
}

export async function updateAdminSidebarTag(id: number, input: unknown): Promise<SidebarTag | null> {
  const existing = await getDb().select().from(sidebarTags).where(eq(sidebarTags.id, id)).get();
  if (!existing) return null;
  const values = parseSidebarTagPatch(toValues(existing), input);
  const updated = await getDb()
    .update(sidebarTags)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(sidebarTags.id, id))
    .returning()
    .get();
  return toTag(updated);
}

export async function deleteAdminSidebarTag(id: number): Promise<boolean> {
  const deleted = await getDb().delete(sidebarTags).where(eq(sidebarTags.id, id)).returning().get();
  return Boolean(deleted);
}
