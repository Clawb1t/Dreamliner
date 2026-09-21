import { formatDurationShort } from "../../infraction/functions/duration.js";
import { getTicketHandlerStats } from "./tickets.js";
import type { TicketPanel } from "../../../config/schemas/tickets.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("tickets");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

/** Dynamic, guild-wide stat placeholders a panel's message/embed text can reference. Distinct
 *  from `src/core/templateExtras.ts`'s `DYNAMIC_EXTRA_KEYS`, which are member-scoped, these two
 *  are computed once per guild rather than per member, so they get their own small module here
 *  instead of overloading that shared, member-scoped one. */
export const TICKET_PANEL_DYNAMIC_KEYS = ["avg_response_time", "avg_resolution_time"] as const;
export type TicketPanelDynamicKey = (typeof TICKET_PANEL_DYNAMIC_KEYS)[number];

/** Every bit of a panel's text a dynamic-variable scan should look at: the message content plus
 *  every renderable embed string. Field name/value pairs are flattened in since a variable is
 *  just as likely to end up in a field as in the title/description. */
function panelText(panel: Pick<TicketPanel, "content" | "embed">): string {
  const embed = panel.embed;
  const fieldText = embed.fields.flatMap((f) => [f.name, f.value]);
  return [panel.content, embed.title, embed.description, embed.author_name, embed.footer_text, ...fieldText].join("\n");
}

/** Which of `TICKET_PANEL_DYNAMIC_KEYS` a panel's text actually references, so a refresh sweep
 *  can skip the stats query entirely for panels that don't use any of them. */
export function keysReferencedInPanel(panel: Pick<TicketPanel, "content" | "embed">): TicketPanelDynamicKey[] {
  const text = panelText(panel);
  return TICKET_PANEL_DYNAMIC_KEYS.filter((key) => text.includes(`{${key}}`));
}

/** Computes only the requested keys' values, as guild-wide averages over the last 7 days.
 *  Best-effort: returns an empty map (leaving the literal `{token}` text in place, same as any
 *  other unresolved template var) rather than throwing, so a DB hiccup never breaks a panel post
 *  or a refresh sweep. Formatted with the same `formatDurationShort` helper `/ticket stats`
 *  already uses, so the numbers read the same way across the bot and the dashboard. */
export async function buildPanelDynamicExtras(
  guildId: string,
  keys: TicketPanelDynamicKey[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  try {
    const { overall } = await getTicketHandlerStats(guildId, { sinceMs: Date.now() - SEVEN_DAYS_MS });
    const notEnoughData = "Not enough data yet";
    const extra: Record<string, string> = {};
    if (keys.includes("avg_response_time")) {
      extra.avg_response_time = overall.avgFirstResponseMs === null ? notEnoughData : formatDurationShort(overall.avgFirstResponseMs);
    }
    if (keys.includes("avg_resolution_time")) {
      extra.avg_resolution_time = overall.avgResolutionMs === null ? notEnoughData : formatDurationShort(overall.avgResolutionMs);
    }
    return extra;
  } catch (err) {
    log.error(`[tickets] Failed to compute panel dynamic stats for guild ${guildId}:`, err);
    return {};
  }
}
