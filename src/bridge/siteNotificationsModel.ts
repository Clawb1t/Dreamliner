/**
 * Website notifications (the bell in the site's navbar): the shapes, validation and audience
 * matching, with no database or Discord access so it can be tested on its own. The store and the
 * bridge glue live in siteNotifications.ts.
 *
 * Audiences are evaluated when a user's notifications are read, never fanned out into per-user
 * rows. The only per-user rows are the read/dismissed state the user creates themselves.
 */
import { z } from "zod";

export const NOTIFICATION_KINDS = ["announcement", "feature", "update", "tip"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_STATUSES = ["draft", "published"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const TITLE_MAX = 100;
export const BODY_MAX = 500;
export const LINK_LABEL_MAX = 30;
export const LINK_MAX = 500;
export const MAX_AUDIENCE_GUILDS = 50;
export const MAX_AUDIENCE_USERS = 100;

const SNOWFLAKE = /^\d{15,22}$/;

/**
 * A link a notification may point at: an https URL, or a path on the website itself. A path must
 * start with a single "/" (so "//evil.example" is out) and hold no whitespace or backslashes,
 * which browsers can turn into a host. Nothing else (javascript:, data:, http:) is allowed.
 */
export function isSafeNotificationLink(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > LINK_MAX) return false;
  if (value.startsWith("/")) {
    return !value.startsWith("//") && !/[\s\\]/.test(value);
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Every `[label](target)` in a body must point somewhere isSafeNotificationLink accepts. */
export function bodyLinksAreSafe(body: string): boolean {
  for (const match of body.matchAll(/\[([^\]\n]*)\]\(([^)\s]*)\)/g)) {
    if (!isSafeNotificationLink(match[2] ?? "")) return false;
  }
  return true;
}

const snowflakeList = (max: number, what: string) =>
  z
    .array(z.string().trim().regex(SNOWFLAKE, `Each ${what} must be a Discord id.`))
    .min(1, `Add at least one ${what}.`)
    .max(max, `At most ${max} ${what}s.`)
    .transform((ids) => [...new Set(ids)]);

export const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({
    type: z.literal("feature"),
    plugin: z.string().trim().regex(/^[a-z0-9_]{1,48}$/, "Pick a plugin."),
    scope: z.enum(["members", "managers"]),
  }),
  z.object({
    type: z.literal("servers"),
    guildIds: snowflakeList(MAX_AUDIENCE_GUILDS, "server id"),
    scope: z.enum(["members", "managers"]),
  }),
  z.object({
    type: z.literal("users"),
    userIds: snowflakeList(MAX_AUDIENCE_USERS, "user id"),
  }),
]);
export type NotificationAudience = z.infer<typeof audienceSchema>;

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => (typeof value === "string" ? value.trim() : value))
    .pipe(z.union([z.string().max(max), z.null(), z.undefined()]))
    .transform((value) => (value === "" ? null : value));

const dateInput = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expiry is not a valid date." });
      return z.NEVER;
    }
    return date.getTime();
  });

const fields = {
  kind: z.enum(NOTIFICATION_KINDS),
  title: z.string().trim().min(1, "Add a title.").max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`),
  body: z
    .string()
    .trim()
    .max(BODY_MAX, `Keep the message under ${BODY_MAX} characters.`)
    .refine(bodyLinksAreSafe, "Links in the message must be https or a page on the site."),
  linkUrl: optionalText(LINK_MAX).refine((value) => value == null || isSafeNotificationLink(value), "The link must be https or a page on the site, like /dashboard."),
  linkLabel: optionalText(LINK_LABEL_MAX),
  icon: optionalText(32).refine((value) => value == null || /^[A-Za-z][A-Za-z0-9]{1,31}$/.test(value), "Unknown icon."),
  audience: audienceSchema,
  status: z.enum(NOTIFICATION_STATUSES),
  pinned: z.boolean(),
  expiresAt: dateInput,
};

export const createNotificationSchema = z.object({
  ...fields,
  body: fields.body.default(""),
  status: fields.status.default("draft"),
  pinned: fields.pinned.default(false),
});
export const updateNotificationSchema = z.object(fields).partial();

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type UpdateNotificationInput = z.infer<typeof updateNotificationSchema>;

/** The first zod issue as one sentence for the composer. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid notification.";
  if (issue.code === "invalid_union_discriminator" || (issue.path[0] === "audience" && issue.code === "invalid_type")) {
    return "Pick who should get this notification.";
  }
  if (issue.path[0] === "kind" && issue.code === "invalid_enum_value") return "Pick a kind.";
  return issue.message;
}

/** Stored notification as the bot passes it around (timestamps in unix ms). */
export type StoredNotification = {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  linkUrl: string | null;
  linkLabel: string | null;
  icon: string | null;
  audience: NotificationAudience;
  status: NotificationStatus;
  pinned: boolean;
  publishedAt: number | null;
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

/** Published, already out, and not past its expiry. */
export function isLive(notification: Pick<StoredNotification, "status" | "publishedAt" | "expiresAt">, now = Date.now()): boolean {
  if (notification.status !== "published") return false;
  if (notification.publishedAt == null || notification.publishedAt > now) return false;
  return notification.expiresAt == null || notification.expiresAt > now;
}

/** One server the bot shares with the user, and whether they can manage it. */
export type Membership = { manager: boolean };

/**
 * Whether `userId` is in a notification's audience.
 *
 * `targetGuilds` is the set of servers a server-based audience (feature or servers) points at,
 * already narrowed to servers the bot is in (and, for a feature, where it's switched on).
 * `memberships` maps the servers the bot knows the user is in to whether they manage them.
 */
export function audienceMatches(
  audience: NotificationAudience,
  userId: string,
  targetGuilds: ReadonlySet<string> | null,
  memberships: ReadonlyMap<string, Membership>,
): boolean {
  switch (audience.type) {
    case "everyone":
      return true;
    case "users":
      return audience.userIds.includes(userId);
    case "feature":
    case "servers": {
      if (!targetGuilds) return false;
      for (const guildId of targetGuilds) {
        const membership = memberships.get(guildId);
        if (!membership) continue;
        if (audience.scope === "members" || membership.manager) return true;
      }
      return false;
    }
  }
}

/** Newest first, pinned ones on top. */
export function sortForFeed<T extends Pick<StoredNotification, "pinned" | "publishedAt" | "id">>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || b.id - a.id,
  );
}
