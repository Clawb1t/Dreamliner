import type {
  IncidentResponseConfig,
  IncidentSeverity,
  IncidentSource,
} from "../../../config/schemas/incidentResponse.js";
import {
  computeIncidentScore,
  isSeverityIncrease,
  severityFromScore,
} from "./weights.js";
import {
  createIncident,
  findOpenIncidentForEntity,
  insertIncidentSignal,
  listIncidentSignals,
  markIncidentResponded,
  updateIncidentAfterSignal,
  type IncidentEntityType,
  type IncidentRow,
} from "./store.js";

export type CorrelateInput = {
  guildId: string;
  source: IncidentSource;
  signalType: string;
  weight: number;
  entityType: IncidentEntityType;
  entityId: string;
  secondaryEntityType?: IncidentEntityType | null;
  secondaryEntityId?: string | null;
  reason: string;
  detail?: string | null;
  /** Human-readable label for the entity (e.g. "@user" or "#channel"), used to title a
   * brand-new incident. Not stored — the dashboard resolves a live label from entityId. */
  entityLabel: string;
};

export type CorrelateResult = {
  incident: IncidentRow;
  escalated: boolean;
  previousSeverity: string | null;
};

/**
 * The Event Correlation step: merges this signal into an existing open incident for the same
 * entity within the correlation window, or opens a new one. Recomputes risk score/severity from
 * the full signal history every time (see `computeIncidentScore`) so the stored numbers can
 * never drift from what actually happened. Returns whether this signal pushed the incident to a
 * severity it hasn't been responded to yet, so the caller can hand off to the Response Policy
 * Engine exactly once per newly-crossed tier.
 */
export async function correlateSignal(
  input: CorrelateInput,
  config: IncidentResponseConfig,
): Promise<CorrelateResult> {
  let incident = await findOpenIncidentForEntity(
    input.guildId,
    input.entityType,
    input.entityId,
    config.correlation_window_ms,
  );

  const previousSeverity = incident?.severity ?? null;
  const previousResponded = incident?.respondedSeverity ?? null;

  if (!incident) {
    incident = await createIncident({
      guildId: input.guildId,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.reason,
    });
  }

  await insertIncidentSignal({
    incidentId: incident.id,
    guildId: input.guildId,
    source: input.source,
    signalType: input.signalType,
    weight: input.weight,
    entityType: input.entityType,
    entityId: input.entityId,
    secondaryEntityType: input.secondaryEntityType,
    secondaryEntityId: input.secondaryEntityId,
    reason: input.reason,
    detail: input.detail,
  });

  const signals = await listIncidentSignals(incident.id);
  const { riskScore, sourceCount } = computeIncidentScore(signals);
  const severity = severityFromScore(riskScore, config.thresholds);

  incident = await updateIncidentAfterSignal(incident.id, {
    riskScore,
    severity,
    signalCount: signals.length,
    sourceCount,
    lastSignalAt: new Date(),
  });

  const escalated = isSeverityIncrease(severity, previousResponded);
  return { incident, escalated, previousSeverity };
}

export async function markResponded(
  incidentId: number,
  severity: IncidentSeverity,
  actionsTaken: string[],
): Promise<void> {
  await markIncidentResponded(incidentId, severity, actionsTaken);
}
