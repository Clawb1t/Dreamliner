import type { GuildMember } from "discord.js";

export const DYNAMIC_EXTRA_KEYS = ["economy_balance", "message_count", "suggestion_count"] as const;
export type DynamicExtraKey = (typeof DYNAMIC_EXTRA_KEYS)[number];

/**
 * Scan one or more pieces of template text and return which dynamic extra keys are actually
 * referenced (as literal `{key}` placeholders), so callers only request the keys their template
 * text needs instead of paying for every dynamic lookup on every render.
 */
export function keysReferencedIn(...texts: Array<string | null | undefined>): DynamicExtraKey[] {
  const found = new Set<DynamicExtraKey>();
  for (const text of texts) {
    if (!text) continue;
    for (const key of DYNAMIC_EXTRA_KEYS) {
      if (text.includes(`{${key}}`)) found.add(key);
    }
  }
  return [...found];
}

/** Best-effort, opt-in dynamic template vars. Callers should pass only the keys their template
 * text actually references, to avoid paying for DB lookups a rendered message doesn't use. Each
 * source is independently guarded so a disabled or missing plugin never breaks the caller. */
export async function buildDynamicExtras(
  member: GuildMember | null | undefined,
  keys: DynamicExtraKey[],
): Promise<Record<string, string>> {
  if (!member || keys.length === 0) return {};
  const out: Record<string, string> = {};
  for (const key of keys) {
    try {
      if (key === "economy_balance") {
        const { isEconomyEnabledFor } = await import("./guildHelpers.js");
        if (!(await isEconomyEnabledFor(member.guild.id))) continue;
        const { getServerBalance } = await import("../plugins/economy/functions/money.js");
        out.economy_balance = String(getServerBalance(member.guild.id, member.id));
      } else if (key === "message_count") {
        const { getGuildMessageCount } = await import("../plugins/utility/functions/messageCounts.js");
        out.message_count = String(await getGuildMessageCount(member.guild.id, member.id));
      } else if (key === "suggestion_count") {
        const { countOpenApproved } = await import("../plugins/suggestions/functions/store.js");
        out.suggestion_count = String(await countOpenApproved(member.guild.id, member.id));
      }
    } catch {
      // best-effort, matches the guarded-import pattern used elsewhere in this codebase
      // (e.g. src/plugins/incident_response/functions/signalBus.ts)
    }
  }
  return out;
}
