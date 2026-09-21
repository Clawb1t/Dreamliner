import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { IncidentResponseConfig, IncidentSource } from "../../../config/schemas/incidentResponse.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { buildIncidentLog } from "../../../core/logging/format.js";
import { emitLog } from "../../../core/logging/send.js";
import { correlateSignal, markResponded } from "./correlate.js";
import { applyPolicyForSeverity } from "./responseActions.js";
import { listIncidentSignals, type IncidentEntityType } from "./store.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("incident_response");

export type ReportSignalInput = {
  guildId: string;
  source: IncidentSource;
  signalType: string;
  weight: number;
  entityType: IncidentEntityType;
  entityId: string;
  /** Mention/label for the entity, used for the incident title and log card (e.g. `<@id>`,
   * `<#id>`, or the guild name for a guild-scoped signal). */
  entityLabel: string;
  secondaryEntityType?: IncidentEntityType | null;
  secondaryEntityId?: string | null;
  reason: string;
  detail?: string | null;
  /** Channel the signal happened in, if any — used by a "lockdown_channel" response action. */
  triggerChannelId?: string | null;
};

const SEVERITY_POLICY_KEY = {
  low: "policy_low",
  medium: "policy_medium",
  high: "policy_high",
  critical: "policy_critical",
} as const;

/**
 * The Event Collector's single entry point. Every source plugin calls this — a guarded dynamic
 * import, exactly like Automod already calls into Raid Mesh — so nothing ever breaks if
 * Incident Response is disabled or the call throws. No-ops entirely if the plugin or that
 * signal's source toggle is off.
 */
export async function reportSignal(client: Client, input: ReportSignalInput): Promise<void> {
  const guildConfig = await configManager.getEffectiveConfig(input.guildId);
  if (guildConfig.plugins.incident_response?.enabled !== true) return;

  const config = getPluginSettings(guildConfig, "incident_response") as IncidentResponseConfig;
  if (!config.sources[input.source]) return;

  let weight = input.weight;
  if (input.entityType === "user") {
    const member = client.guilds.cache.get(input.guildId)?.members.cache.get(input.entityId);
    if (member) {
      try {
        const { getPassportDeescalationFactor } = await import("../../passport/functions/gate.js");
        weight = Math.round(weight * (await getPassportDeescalationFactor(member)));
      } catch {
        // Passport unavailable or errored, keep the unadjusted weight.
      }
    }
  }

  const { incident, escalated, previousSeverity } = await correlateSignal(
    {
      guildId: input.guildId,
      source: input.source,
      signalType: input.signalType,
      weight,
      entityType: input.entityType,
      entityId: input.entityId,
      secondaryEntityType: input.secondaryEntityType,
      secondaryEntityId: input.secondaryEntityId,
      reason: input.reason,
      detail: input.detail,
      entityLabel: input.entityLabel,
    },
    config,
  );

  let actionsTaken: string[] = [];
  if (escalated) {
    const guild = client.guilds.cache.get(input.guildId);
    const policyKey = SEVERITY_POLICY_KEY[incident.severity];
    const policy = config[policyKey];
    if (guild && policy.actions.length > 0) {
      actionsTaken = await applyPolicyForSeverity({
        client,
        guild,
        guildConfig,
        incident,
        policy,
        triggerChannelId: input.triggerChannelId,
      });
    }
    await markResponded(incident.id, incident.severity, actionsTaken);
  }

  // Always visible, regardless of policy: a brand-new incident, or a severity escalation.
  const isNewIncident = previousSeverity === null;
  if (isNewIncident || escalated) {
    const signals = await listIncidentSignals(incident.id);
    const reasons = [...new Set(signals.map((s) => s.reason))].slice(0, 6);
    const policy = config[SEVERITY_POLICY_KEY[incident.severity]];
    const pingPrefix = policy.notify_roles.length ? `${policy.notify_roles.map((r) => `<@&${r}>`).join(" ")} ` : "";

    await emitLog(
      client,
      guildConfig,
      buildIncidentLog({
        id: incident.id,
        severity: incident.severity,
        entityLabel: `${pingPrefix}${input.entityLabel}`,
        title: incident.title,
        riskScore: incident.riskScore,
        signalCount: incident.signalCount,
        sourceCount: incident.sourceCount,
        reasons,
        actionsTaken,
      }),
      {
        guildId: input.guildId,
        eventType: "incident_response",
        summary: `Incident #${incident.id} ${isNewIncident ? "opened" : "escalated"}: ${incident.severity}.`,
        actorId: client.user?.id ?? null,
        targetId: input.entityType === "user" ? input.entityId : null,
        payload: { incidentId: incident.id },
        caseLogOverride: config.log_channel_id,
      },
    ).catch((err) => log.error("Failed to post incident log:", err));
  }
}
