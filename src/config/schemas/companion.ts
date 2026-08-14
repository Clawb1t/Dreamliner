import { z } from "zod";

export const COMPANION_SETUP_TYPES = ["default", "sequential", "predefined", "clone", "dynamic"] as const;
export const COMPANION_PERMISSION_SOURCES = ["category", "hub"] as const;

export const COMPANION_FEATURE_KEYS = [
  "name",
  "limit",
  "status",
  "lock",
  "claim",
  "reject",
  "permit",
  "ghost",
  "lfm",
  "text",
  "bitrate",
  "invite",
  "transfer",
  "nsfw",
  "interface",
  "interface_ping",
  "manage_channel",
  "move_member",
  "autotext",
  "region",
] as const;

export type CompanionSetupType = (typeof COMPANION_SETUP_TYPES)[number];
export type CompanionPermissionSource = (typeof COMPANION_PERMISSION_SOURCES)[number];
export type CompanionFeatureKey = (typeof COMPANION_FEATURE_KEYS)[number];

const featureToggle = (description: string, fallback = true) =>
  z.boolean().default(fallback).describe(description);

export const zCompanionFeatures = z.strictObject({
  name: featureToggle("Owners can rename their temporary channel."),
  limit: featureToggle("Owners can set a user limit."),
  status: featureToggle("Owners can set a voice channel status."),
  lock: featureToggle("Owners can lock and unlock their channel."),
  claim: featureToggle("Members can claim a channel after the owner leaves."),
  reject: featureToggle("Owners can reject users or roles and kick them."),
  permit: featureToggle("Owners can permit users or roles into a locked/ghosted channel."),
  ghost: featureToggle("Owners can hide the channel from the channel list."),
  lfm: featureToggle("Owners can post Looking for Members in the LFM channel."),
  text: featureToggle("Owners can create a linked temporary text channel."),
  bitrate: featureToggle("Owners can change bitrate."),
  invite: featureToggle("Owners can DM invite links to members."),
  transfer: featureToggle("Owners can transfer ownership."),
  nsfw: featureToggle("Owners can mark the channel NSFW.", false),
  interface: featureToggle("Post a control panel in new temporary channels."),
  interface_ping: featureToggle("Post a public confirmation when someone uses the control panel.", false),
  manage_channel: featureToggle("Give owners Discord Manage Channel on their room."),
  move_member: featureToggle("Give owners Discord Move Members on their room."),
  autotext: featureToggle("Automatically create a linked text channel with each room.", false),
  region: featureToggle("Owners can change the voice region."),
});

export const zCompanionSetup = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this join-to-create setup on or off."),
  name: z.string().max(80).default("").describe("Dashboard label for this setup."),
  hub_channel_id: z
    .string()
    .min(1)
    .describe("Join-to-create voice channel. Joining it creates or assigns a temporary room."),
  type: z
    .enum(COMPANION_SETUP_TYPES)
    .default("default")
    .describe(
      "How rooms are named and created: default (owner customises), sequential (Name 1, Name 2), predefined (template variables), clone (copy the hub), dynamic (keep empty rooms ready).",
    ),
  name_template: z
    .string()
    .max(100)
    .default("{user_display}'s channel")
    .describe(
      "Name for new rooms. Placeholders: {user_display}, {username}, {seq}, {animals}, {colors}, {trees}. Ignored for clone.",
    ),
  user_limit: z
    .number()
    .int()
    .min(0)
    .max(99)
    .default(0)
    .describe("Default user limit. 0 is unlimited. Clone uses the hub's limit instead."),
  bitrate: z
    .number()
    .int()
    .min(0)
    .max(384)
    .default(0)
    .describe("Default bitrate in kbps. 0 inherits the hub or server. Clone uses the hub bitrate."),
  category_id: z
    .string()
    .max(32)
    .default("")
    .describe("Category for new rooms. Empty uses the hub's category."),
  permission_source: z
    .enum(COMPANION_PERMISSION_SOURCES)
    .default("category")
    .describe("Copy permission overwrites from the category or from the join-to-create hub."),
  editable: z
    .boolean()
    .default(true)
    .describe("Owners can change the name and user limit (when those features are also enabled)."),
  auto_text: z
    .boolean()
    .default(false)
    .describe("Create a private text channel with each room. Also requires the autotext feature."),
  default_lock: z.boolean().default(false).describe("Lock new rooms so only the owner can join."),
  default_ghost: z.boolean().default(false).describe("Hide new rooms from the channel list."),
  default_nsfw: z.boolean().default(false).describe("Mark new rooms as NSFW."),
  default_status: z.string().max(500).default("").describe("Optional voice status set on new rooms."),
  region: z
    .string()
    .max(64)
    .default("")
    .describe("Voice region for new rooms. Empty lets Discord pick automatically."),
  dynamic_ready: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(3)
    .describe("For dynamic setups, how many empty rooms to keep ready."),
});

export const zCompanionChannelsConfig = z.strictObject({
  setups: z
    .array(zCompanionSetup)
    .max(25)
    .default([])
    .describe("Join-to-create setups. Each one needs a hub voice channel."),
  features: zCompanionFeatures.default({}).describe("Which owner controls are allowed on this server."),
  log_channel_id: z
    .string()
    .max(32)
    .default("")
    .describe("Optional log channel for room create, delete, claim, and transfer."),
  lfm_channel_id: z
    .string()
    .max(32)
    .default("")
    .describe("Channel where Looking for Members posts go."),
  staff_role_id: z
    .string()
    .max(32)
    .default("")
    .describe("Members with this role can manage any temporary room."),
  text_channel_message: z
    .string()
    .max(2000)
    .default("")
    .describe("Optional message posted in new linked text channels. Supports {user_display}, {channel}, {guild}."),
  text_access_role_id: z
    .string()
    .max(32)
    .default("")
    .describe("Optional extra role that can always see linked text channels."),
  join_role_id: z
    .string()
    .max(32)
    .default("")
    .describe("Optional role given while a member is in a temporary room."),
  member_role_id: z
    .string()
    .max(32)
    .default("")
    .describe("Optional member role used when restoring visibility after ghost/lock."),
});

export type CompanionFeatures = z.infer<typeof zCompanionFeatures>;
export type CompanionSetup = z.infer<typeof zCompanionSetup>;
export type CompanionChannelsConfig = z.infer<typeof zCompanionChannelsConfig>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LEGACY_COMPANION_KEYS = ["can_create", "can_delete", "name_template"] as const;

function stripLegacyCompanionKeys(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of LEGACY_COMPANION_KEYS) {
    if (key in obj) {
      delete obj[key];
      changed = true;
    }
  }
  return changed;
}

/** Strip legacy hub-command config (`name_template`, `can_create`, `can_delete`) from config and overrides. */
export function migrateCompanionChannelsInConfig(value: Record<string, unknown>): boolean {
  const plugins = value.plugins;
  if (!isPlainObject(plugins)) return false;
  const section = plugins.companion_channels;
  if (!isPlainObject(section)) return false;

  let changed = false;
  const config = section.config;
  if (isPlainObject(config)) {
    if (stripLegacyCompanionKeys(config)) changed = true;
    if (!Array.isArray(config.setups)) {
      config.setups = [];
      changed = true;
    }
  }

  if (Array.isArray(section.overrides)) {
    const next: unknown[] = [];
    for (const override of section.overrides) {
      if (!isPlainObject(override)) {
        next.push(override);
        continue;
      }
      if (isPlainObject(override.config) && stripLegacyCompanionKeys(override.config)) {
        changed = true;
      }
      const leftover = isPlainObject(override.config) ? Object.keys(override.config) : [];
      if (leftover.length === 0) {
        changed = true;
        continue;
      }
      next.push(override);
    }
    if (next.length !== section.overrides.length) {
      section.overrides = next;
      changed = true;
    }
  }

  return changed;
}
