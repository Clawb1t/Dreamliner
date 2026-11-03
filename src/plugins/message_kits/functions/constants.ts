/** Message Kits: shared constants. Kept free of discord.js / database imports so tests and the
 *  website contract can rely on them. */

export const PLUGIN = "message_kits";

/** Button / select / modal customId prefix, routed in bot.ts.
 *  Buttons and selects: `mk:<kitId>:<componentId>`. Forms: `mk:f:<kitId>:<componentId>[:<optionId>]`. */
export const MK_PREFIX = "mk:";
export const MK_FORM_PREFIX = "mk:f:";

/** The application-owned webhook kits are sent through ("Send as a custom identity"). */
export const KIT_WEBHOOK_NAME = "Dreamliner Kits";

const MB = 1024 * 1024;

/** Hard limits, mirrored on the website as KIT_LIMITS (returned by GET kits). Everything is free. */
export const KIT_LIMITS = {
  kits: 100,
  versionsPerKit: 25,
  schedules: 25,
  targetsPerSend: 10,
  assets: 60,
  assetBytes: 8 * MB,
  assetTotalBytes: 250 * MB,
  assetImageTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  formFields: 5,
  roleActionRoles: 10,
  folderName: 40,
  kitName: 80,
  description: 200,
} as const;

/** Sent copies deleted longer ago than this are forgotten. */
export const POST_RETENTION_MS = 90 * 86_400_000;

/** A schedule that fails this many times in a row is turned off. */
export const SCHEDULE_MAX_FAILURES = 5;
