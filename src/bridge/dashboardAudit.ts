import type { Client } from "discord.js";
import { configManager } from "../config/manager.js";
import { emitLog } from "../core/logging/send.js";
import type { LogEventType } from "../core/logging/events.js";
import type { LogEmojiCategory } from "../core/logging/emojis.js";

const DASHBOARD_EVENT_EMOJI: Partial<Record<LogEventType, LogEmojiCategory>> = {
  dashboard_config: "serverUpdate",
  dashboard_tag: "edit",
  dashboard_command: "edit",
  dashboard_suggestion: "modDefault",
  dashboard_automod: "serverUpdate",
  dashboard_chart: "edit",
  dashboard_scam_protect: "serverUpdate",
  dashboard_welcome: "edit",
  dashboard_review: "modDefault",
  dashboard_bot_brand: "edit",
  dashboard_economy: "serverUpdate",
};

export type DashboardAuditInput = {
  eventType: LogEventType;
  title: string;
  summary: string;
  details?: string[];
  /** Field-level changes (shown in Discord + dashboard Logs "Changes" section). */
  changes?: string[];
  targetId?: string | null;
  payload?: Record<string, unknown>;
  /** Defaults to web dashboard. Use discord for `/config upload` etc. */
  source?: "dashboard" | "discord";
};

/**
 * Persist + Discord-send a dashboard/admin action through the normal logs pipeline.
 * Never throws to callers (logging must not break saves).
 */
export async function logDashboardAction(
  client: Client,
  guildId: string,
  actorId: string,
  input: DashboardAuditInput,
): Promise<void> {
  try {
    if (!guildId || !actorId) return;
    const guildConfig = await configManager.getEffectiveConfig(guildId);
    const user = await client.users.fetch(actorId).catch(() => null);
    const details = (input.details ?? []).filter((line) => line.trim().length > 0);
    const changes = (input.changes ?? []).filter((line) => line.trim().length > 0);
    const source = input.source ?? "dashboard";
    const sourceLabel = source === "discord" ? "Discord command" : "Web dashboard";
    const changePreview = changes.slice(0, 20).map((line) => `• ${line}`);
    const changeExtra =
      changes.length > 20
        ? `**Changes**\n${changes.map((line) => `• ${line}`).join("\n")}`
        : undefined;

    await emitLog(
      client,
      guildConfig,
      {
        title: input.title,
        avatarUrl: user?.displayAvatarURL({ size: 128 }) ?? null,
        information: [
          `Actor: <@${actorId}> (\`${actorId}\`)`,
          `Source: ${sourceLabel}`,
          input.summary,
          ...details,
          ...(changePreview.length
            ? [`Changes (${changes.length}):`, ...changePreview]
            : []),
        ],
        extra: changeExtra,
        emojiCategory: DASHBOARD_EVENT_EMOJI[input.eventType] ?? "modDefault",
      },
      {
        guildId,
        eventType: input.eventType,
        actorId,
        targetId: input.targetId ?? null,
        summary: input.summary,
        payload: {
          source,
          ...(changes.length ? { changes } : {}),
          ...(input.payload ?? {}),
        },
      },
    );
  } catch (error) {
    console.warn(
      `[dashboard-audit] failed to log ${input.eventType} in guild ${guildId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Fire-and-forget wrapper for bridge handlers. */
export function trackDashboardAction(
  client: Client,
  guildId: string,
  actorId: string,
  input: DashboardAuditInput,
): void {
  void logDashboardAction(client, guildId, actorId, input);
}
