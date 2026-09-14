import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SOURCES = ["automod", "raid", "impersonation", "scam_protect", "nuke_detection"] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const INCIDENT_ACTION_TYPES = [
  "timeout",
  "kick",
  "softban",
  "ban",
  "lockdown_channel",
  "lockdown_server",
] as const;
export type IncidentActionType = (typeof INCIDENT_ACTION_TYPES)[number];

const roleIdList = (help: string) => z.array(z.string()).default([]).describe(help);

export const zIncidentAction = z.strictObject({
  type: z.enum(INCIDENT_ACTION_TYPES).describe("Action to run when this severity is first reached."),
  duration_ms: z
    .number()
    .int()
    .min(60_000)
    .optional()
    .describe("Duration for a timeout action."),
  delete_message_days: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe("Days of messages to delete on softban/ban (0-7)."),
  lockdown_duration_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How long the lockdown lasts before auto-unlocking (0 = manual unlock only)."),
});

export const zIncidentSeverityPolicy = z.strictObject({
  actions: z
    .array(zIncidentAction)
    .default([])
    .describe("Punitive/lockdown actions to run the first time an incident reaches this severity. Empty = alert only."),
  notify_roles: roleIdList("Roles pinged in the incident alert when this severity is first reached."),
});

export const zIncidentResponseConfig = z.strictObject({
  log_channel_id: channelId("Channel Incident Response posts incident alerts to. Falls back to the server moderation log channel if empty."),
  correlation_window_ms: z
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(1_800_000)
    .describe("Signals about the same person/channel/server within this window are merged into one incident."),
  thresholds: z
    .strictObject({
      medium: z.number().int().min(1).default(6),
      high: z.number().int().min(1).default(14),
      critical: z.number().int().min(1).default(26),
    })
    .default({})
    .describe("Risk score needed to reach each severity tier. Below 'medium' is Low."),
  sources: z
    .strictObject({
      automod: z.boolean().default(true).describe("Feed Automod hits into Incident Response."),
      raid: z.boolean().default(true).describe("Feed Automod's raid detector into Incident Response."),
      impersonation: z.boolean().default(true).describe("Feed Impersonation Detection alerts into Incident Response."),
      scam_protect: z.boolean().default(true).describe("Feed Scam Protect trips into Incident Response."),
      nuke_detection: z
        .boolean()
        .default(true)
        .describe("Watch the audit log for mass channel/role deletion, mass bans/kicks, webhook bursts, and surprise admin grants."),
    })
    .default({}),
  nuke: z
    .strictObject({
      channel_delete_count: z.number().int().min(2).default(3),
      channel_delete_window_ms: z.number().int().min(1000).default(30_000),
      role_delete_count: z.number().int().min(2).default(3),
      role_delete_window_ms: z.number().int().min(1000).default(30_000),
      ban_count: z.number().int().min(2).default(5),
      ban_window_ms: z.number().int().min(1000).default(60_000),
      kick_count: z.number().int().min(2).default(5),
      kick_window_ms: z.number().int().min(1000).default(60_000),
      webhook_count: z.number().int().min(2).default(3),
      webhook_window_ms: z.number().int().min(1000).default(60_000),
      admin_grant_new_account_hours: z
        .number()
        .int()
        .min(0)
        .default(72)
        .describe("Flag granting Administrator to an account created within this many hours (0 = off)."),
    })
    .default({})
    .describe("Thresholds for the built-in server-nuke detectors."),
  policy_low: zIncidentSeverityPolicy.default({}),
  policy_medium: zIncidentSeverityPolicy.default({}),
  policy_high: zIncidentSeverityPolicy.default({}),
  policy_critical: zIncidentSeverityPolicy.default({}),
  can_manage: boolPerm("view, resolve, dismiss, and unlock incidents"),
});

export const zIncidentResponsePluginSection = zPluginSection(zIncidentResponseConfig.shape, false);

export type IncidentAction = z.infer<typeof zIncidentAction>;
export type IncidentSeverityPolicy = z.infer<typeof zIncidentSeverityPolicy>;
export type IncidentResponseConfig = z.infer<typeof zIncidentResponseConfig>;
