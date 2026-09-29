import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";
import { isValidTimeZone } from "./images.js";
import { zWelcomeCardConfig, zWelcomeEmbedConfig } from "./welcome.js";

/** Whose clock decides when a birthday starts: the server's timezone, or the member's own (set with
 *  /birthday set, falling back to the server's when they didn't give one). */
export const BIRTHDAY_TIMEZONE_MODES = ["server", "member"] as const;
/** When a 29 February birthday is celebrated in years without one. */
export const BIRTHDAY_LEAP_DAY_MODES = ["feb28", "mar1"] as const;

/** Dreamliner's birthday app emoji, used in birthday messages, buttons and replies. */
export const BIRTHDAY_EMOJI = "<:icons_bday:1544418010796924988>";
/** Other app emojis the plugin uses (every Birthdays emoji comes from the bot's app emojis). */
export const BIRTHDAY_TADA_EMOJI = "<:icons_tada:1544417975472492594>";
export const BIRTHDAY_DATE_EMOJI = "<:icons_calenderdate:1544418081038663701>";

export const MAX_BIRTHDAY_LINK_BUTTONS = 4;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const zBirthdayWishButton = z.strictObject({
  enabled: z.boolean().default(true).describe("Add a button members press to wish the birthday member a happy birthday."),
  label: z.string().max(60).default("Wish happy birthday").describe("Button label before the tally."),
  emoji: z.string().max(128).default(BIRTHDAY_EMOJI).describe("Button emoji (unicode, emoji id, or <:name:id>)."),
  show_count: z.boolean().default(true).describe("Show how many people have sent wishes on the button."),
});

/** Rows can be saved half-filled from the dashboard; ones without a label and an http(s) link
 *  are skipped when posting. */
export const zBirthdayLinkButton = z.strictObject({
  label: z.string().max(80).default("").describe("Button label."),
  url: z.string().max(512).default("").describe("Where the button goes (https://...)."),
  emoji: z.string().max(128).default("").describe("Optional button emoji."),
});

export const zBirthdayThread = z.strictObject({
  enabled: z.boolean().default(false).describe("Open a thread on the announcement for birthday wishes."),
  name: z
    .string()
    .max(100)
    .default("Happy birthday {user_display}!")
    .describe("Thread name. Supports placeholders."),
  auto_archive_minutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .default(1440)
    .describe("Archive the thread after this long without messages (1 hour, 1 day, 3 days or 1 week)."),
});

export const zBirthdayAnnouncement = z.strictObject({
  enabled: z.boolean().default(true).describe("Post a birthday announcement in a channel."),
  channel_id: channelId("Channel birthday announcements are posted in."),
  content: z
    .string()
    .max(2000)
    .default(`${BIRTHDAY_EMOJI} Happy birthday {user}! Have an amazing day.`)
    .describe(
      "Announcement text. Supports placeholders plus {age}, {age_ordinal}, {birthday}, {birthday_date} and {birthdays_today}.",
    ),
  embed: zWelcomeEmbedConfig.default({}),
  card: zWelcomeCardConfig.default({
    greeting_text: "Happy birthday, {user_display}!",
    subtitle_text: "Have an amazing day!",
  }),
  ping_member: z.boolean().default(true).describe("Ping the birthday member (when {user} is in the message)."),
  ping_roles: z.array(z.string()).max(5).default([]).describe("Roles to ping with the announcement."),
  wish_button: zBirthdayWishButton.default({}),
  link_buttons: z
    .array(zBirthdayLinkButton)
    .max(MAX_BIRTHDAY_LINK_BUTTONS)
    .default([])
    .describe("Link buttons shown under the announcement."),
  reactions: z.array(z.string().max(128)).max(5).default([]).describe("Emojis Dreamliner reacts to the announcement with."),
  thread: zBirthdayThread.default({}),
  delete_after_hours: z
    .number()
    .int()
    .min(0)
    .max(168)
    .default(0)
    .describe("Delete the announcement this many hours after it's posted. 0 keeps it."),
});

export const zBirthdayDm = z.strictObject({
  enabled: z.boolean().default(false).describe("Send the birthday member a private message too."),
  content: z
    .string()
    .max(2000)
    .default(`Happy birthday from everyone at **{guild}**! ${BIRTHDAY_EMOJI}`)
    .describe("DM text. Supports the same placeholders as the announcement."),
  embed: zWelcomeEmbedConfig.default({}),
  card: zWelcomeCardConfig.default({
    greeting_text: "Happy birthday!",
    subtitle_text: "From everyone at {guild}",
  }),
});

export const zBirthdayRole = z.strictObject({
  enabled: z.boolean().default(false).describe("Give the birthday member a role for their birthday."),
  role_id: z.string().default("").describe("The birthday role."),
  duration_hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("How long they keep the role, in hours from when their birthday starts."),
});

export const zBirthdaysConfig = z.strictObject({
  announcement: zBirthdayAnnouncement.default({}),
  dm: zBirthdayDm.default({}),
  role: zBirthdayRole.default({}),
  timezone: z
    .string()
    .max(64)
    .default("UTC")
    .refine(isValidTimeZone, "Unknown timezone.")
    .describe("The server's timezone, e.g. Europe/London. Birthdays start at the time below in this timezone."),
  timezone_mode: z
    .enum(BIRTHDAY_TIMEZONE_MODES)
    .default("member")
    .describe("server = everyone's birthday starts in the server's timezone, member = in their own timezone when they set one."),
  celebrate_time: z
    .string()
    .regex(TIME_OF_DAY, "Use 24-hour HH:MM.")
    .default("00:00")
    .describe("Time of day birthdays are celebrated, as 24-hour HH:MM."),
  leap_day: z
    .enum(BIRTHDAY_LEAP_DAY_MODES)
    .default("feb28")
    .describe("When to celebrate 29 February birthdays in years without one."),
  show_age: z.boolean().default(true).describe("Show ages (from birth years members chose to share)."),
  require_year: z.boolean().default(false).describe("Make members include their birth year in /birthday set."),
  allowed_roles: z.array(z.string()).default([]).describe("If set, only members with one of these roles are celebrated."),
  ignored_roles: z.array(z.string()).default([]).describe("Members with any of these roles are never celebrated."),
  can_set: boolPerm("set, change or remove their own birthday with /birthday set and /birthday remove"),
  can_view: boolPerm("see members' birthdays and upcoming birthdays with /birthday view and /birthday upcoming"),
  can_manage: boolPerm("set or remove other members' birthdays with /birthday manage"),
});

export type BirthdayAnnouncement = z.infer<typeof zBirthdayAnnouncement>;
export type BirthdayDm = z.infer<typeof zBirthdayDm>;
export type BirthdaysConfig = z.infer<typeof zBirthdaysConfig>;

export const zBirthdaysPluginSection = zPluginSection(zBirthdaysConfig.shape);
