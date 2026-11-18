import { z } from "zod";

/**
 * Sidebar tags: the small pills ("New", "Beta", or a custom one) shown next to plugins and pages in
 * the website's server dashboard sidebar. Superusers manage them on the platform banners page.
 * The site puts colours straight into inline styles, so every colour is a strict hex value and every
 * icon comes from a fixed list the site knows how to draw. Pure (no DB) so the tests can import it.
 */

export const SIDEBAR_TAG_KINDS = ["new", "beta", "custom"] as const;
export const SIDEBAR_TAG_STYLES = ["solid", "soft", "outline"] as const;
/** Icons the site has a glyph for. Keep in sync with SIDEBAR_TAG_ICONS on the website. */
export const SIDEBAR_TAG_ICONS = [
  "spark",
  "star",
  "zap",
  "flame",
  "rocket",
  "crown",
  "gem",
  "heart",
  "gift",
  "bell",
  "clock",
  "lock",
  "shield",
  "trophy",
  "flask",
  "tag",
] as const;

export type SidebarTagKind = (typeof SIDEBAR_TAG_KINDS)[number];
export type SidebarTagStyle = (typeof SIDEBAR_TAG_STYLES)[number];
export type SidebarTagIcon = (typeof SIDEBAR_TAG_ICONS)[number];

/** At most this many tags show on one sidebar item; extras (by sort, then id) are dropped. */
export const MAX_TAGS_PER_ITEM = 2;

export const SIDEBAR_TAG_LABEL_MAX = 14;

/** Default label and colour for the preset kinds (the site draws New/Beta with its own CSS). */
export const SIDEBAR_TAG_PRESETS: Record<Exclude<SidebarTagKind, "custom">, { label: string; color: string; textColor: string }> = {
  new: { label: "New", color: "#5865f2", textColor: "#ffffff" },
  beta: { label: "Beta", color: "#f9a62b", textColor: "#3a2300" },
};

/**
 * A sidebar item key, exactly as the site's sidebar names it: a plugin ("team_control"), a built-in
 * section ("widgets", "server_autopilot"), or a nested page ("team_control/kiosk",
 * "tickets/tickets_ai"). The bot doesn't know the site's page list, so it only checks the shape and
 * the site validates against its own sidebar.
 */
export const SIDEBAR_TARGET_PATTERN = /^[a-z0-9_]{1,48}(?:\/[a-z0-9_]{1,48})?$/;

export class SidebarTagError extends Error {}

const hex = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "must be a hex colour like #ff7a00")
  .transform((value) => value.toLowerCase());

const dateish = z
  .union([z.string(), z.number(), z.date(), z.null()])
  .transform((value, ctx) => {
    if (value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "is not a valid date" });
      return z.NEVER;
    }
    return date;
  });

const fields = {
  target: z.string().trim().toLowerCase().regex(SIDEBAR_TARGET_PATTERN, "must be a sidebar item key like team_control or team_control/kiosk"),
  kind: z.enum(SIDEBAR_TAG_KINDS),
  label: z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "is required").max(SIDEBAR_TAG_LABEL_MAX, `must be ${SIDEBAR_TAG_LABEL_MAX} characters or fewer`)),
  color: hex,
  textColor: hex.nullable(),
  icon: z.enum(SIDEBAR_TAG_ICONS).nullable(),
  style: z.enum(SIDEBAR_TAG_STYLES),
  startsAt: dateish,
  endsAt: dateish,
  enabled: z.boolean(),
  sort: z.number().int().min(-1000).max(1000),
};

const createSchema = z.object({
  target: fields.target,
  kind: fields.kind,
  label: fields.label.optional(),
  color: fields.color.optional(),
  textColor: fields.textColor.optional(),
  icon: fields.icon.optional(),
  style: fields.style.optional(),
  startsAt: fields.startsAt.optional(),
  endsAt: fields.endsAt.optional(),
  enabled: fields.enabled.optional(),
  sort: fields.sort.optional(),
});

const patchSchema = createSchema.partial();

export type SidebarTagValues = {
  target: string;
  kind: SidebarTagKind;
  label: string;
  color: string;
  textColor: string | null;
  icon: SidebarTagIcon | null;
  style: SidebarTagStyle;
  startsAt: Date | null;
  endsAt: Date | null;
  enabled: boolean;
  sort: number;
};

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "input";
  return `${field} ${issue?.message ?? "is invalid"}.`;
}

function checkWindow(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw new SidebarTagError("endsAt must be after startsAt.");
  }
}

/** Fills in the preset label/colours for New and Beta when they're left out. */
function withPresetDefaults(values: SidebarTagValues, explicit: { label: boolean; color: boolean; textColor: boolean }): SidebarTagValues {
  if (values.kind === "custom") return values;
  const preset = SIDEBAR_TAG_PRESETS[values.kind];
  return {
    ...values,
    label: explicit.label ? values.label : preset.label,
    color: explicit.color ? values.color : preset.color,
    textColor: explicit.textColor ? values.textColor : preset.textColor,
  };
}

export function parseSidebarTagCreate(input: unknown): SidebarTagValues {
  const result = createSchema.safeParse(input ?? {});
  if (!result.success) throw new SidebarTagError(firstIssue(result.error));
  const data = result.data;
  if (data.kind === "custom" && !data.label) throw new SidebarTagError("label is required for a custom tag.");
  if (data.kind === "custom" && !data.color) throw new SidebarTagError("color is required for a custom tag.");
  const values = withPresetDefaults(
    {
      target: data.target,
      kind: data.kind,
      label: data.label ?? "",
      color: data.color ?? "",
      textColor: data.textColor ?? null,
      icon: data.icon ?? null,
      style: data.style ?? "solid",
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      // New tags go live straight away unless the caller says otherwise.
      enabled: data.enabled ?? true,
      sort: data.sort ?? 0,
    },
    { label: Boolean(data.label), color: Boolean(data.color), textColor: data.textColor !== undefined },
  );
  checkWindow(values.startsAt, values.endsAt);
  return values;
}

/** Merges a partial update onto the stored values and re-validates the whole result. */
export function parseSidebarTagPatch(existing: SidebarTagValues, input: unknown): SidebarTagValues {
  const result = patchSchema.safeParse(input ?? {});
  if (!result.success) throw new SidebarTagError(firstIssue(result.error));
  const data = result.data;
  const next: SidebarTagValues = {
    target: data.target ?? existing.target,
    kind: data.kind ?? existing.kind,
    label: data.label ?? existing.label,
    color: data.color ?? existing.color,
    textColor: data.textColor !== undefined ? data.textColor : existing.textColor,
    icon: data.icon !== undefined ? data.icon : existing.icon,
    style: data.style ?? existing.style,
    startsAt: data.startsAt !== undefined ? data.startsAt : existing.startsAt,
    endsAt: data.endsAt !== undefined ? data.endsAt : existing.endsAt,
    enabled: data.enabled ?? existing.enabled,
    sort: data.sort ?? existing.sort,
  };
  if (!next.label) throw new SidebarTagError("label is required.");
  checkWindow(next.startsAt, next.endsAt);
  return next;
}

export type SidebarTagWindowRow = {
  id: number;
  target: string;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  sort: number;
};

/** Enabled, started (or no start), and not yet ended (or no end). */
export function isSidebarTagLive(row: Omit<SidebarTagWindowRow, "id" | "target" | "sort">, now: Date): boolean {
  if (!row.enabled) return false;
  const t = now.getTime();
  if (row.startsAt && row.startsAt.getTime() > t) return false;
  if (row.endsAt && row.endsAt.getTime() <= t) return false;
  return true;
}

/** The tags the sidebar should show right now: live ones, at most MAX_TAGS_PER_ITEM per item,
 *  ordered by sort then id within each item. */
export function selectActiveSidebarTags<T extends SidebarTagWindowRow>(rows: readonly T[], now: Date): T[] {
  const live = rows.filter((row) => isSidebarTagLive(row, now)).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const perTarget = new Map<string, number>();
  const picked: T[] = [];
  for (const row of live) {
    const count = perTarget.get(row.target) ?? 0;
    if (count >= MAX_TAGS_PER_ITEM) continue;
    perTarget.set(row.target, count + 1);
    picked.push(row);
  }
  return picked;
}
