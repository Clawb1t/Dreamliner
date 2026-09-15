import type { GuildMember } from "discord.js";
import type { SlowmodeConfig, SlowmodeRuleTarget } from "../../../config/schemas/plugins.js";
import { formatDuration } from "../../../core/datetime.js";
import type { Translator } from "../../../i18n/index.js";

export const ALL_CHANNELS = "*";

export type NormalizedSlowmodeRule = {
  id: number;
  target: SlowmodeRuleTarget;
  target_id: string;
  seconds: number;
  channels: string[];
};

export type ResolvedSlowmodeDelay = {
  seconds: number;
  source: "user" | "role" | "default" | "none";
  rule?: NormalizedSlowmodeRule;
};

export function normalizeSlowmodeRules(rules: SlowmodeConfig["rules"]): NormalizedSlowmodeRule[] {
  let nextId = 1;
  const used = new Set<number>();

  return rules.map((rule) => {
    let id = rule.id;
    if (!id || used.has(id)) {
      while (used.has(nextId)) nextId++;
      id = nextId++;
    }
    used.add(id);

    const channels =
      !rule.channels?.length || rule.channels.includes(ALL_CHANNELS) ? [ALL_CHANNELS] : [...new Set(rule.channels)];

    return {
      id,
      target: rule.target,
      target_id: rule.target_id,
      seconds: rule.seconds,
      channels,
    };
  });
}

export function nextSlowmodeRuleId(rules: NormalizedSlowmodeRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

export function ruleAppliesToChannel(rule: NormalizedSlowmodeRule, channelId: string): boolean {
  return rule.channels.includes(ALL_CHANNELS) || rule.channels.includes(channelId);
}

export function formatChannelScope(channels: string[], t: Translator): string {
  if (!channels.length || channels.includes(ALL_CHANNELS)) return t("slowmode.allChannels", "All channels");
  return channels.map((id) => `<#${id}>`).join(", ");
}

export function formatSlowmodeRule(rule: NormalizedSlowmodeRule, t: Translator): string {
  const target = rule.target === "user" ? `<@${rule.target_id}>` : `<@&${rule.target_id}>`;
  const targetLabel = rule.target === "user" ? t("slowmode.targetUser", "user") : t("slowmode.targetRole", "role");
  return `**#${rule.id}** · ${targetLabel} ${target} · **${formatSeconds(rule.seconds, t)}** · ${formatChannelScope(rule.channels, t)}`;
}

export function formatSeconds(seconds: number, t: Translator): string {
  if (seconds <= 0) return t("slowmode.none", "none");
  return formatDuration(seconds * 1000);
}

export function resolveIndividualDelay(
  config: SlowmodeConfig,
  member: GuildMember,
  channelId: string,
): ResolvedSlowmodeDelay {
  const rules = normalizeSlowmodeRules(config.rules).filter((rule) => ruleAppliesToChannel(rule, channelId));

  const userRule = rules.find((rule) => rule.target === "user" && rule.target_id === member.id);
  if (userRule) {
    return { seconds: userRule.seconds, source: "user", rule: userRule };
  }

  const roleRules = rules.filter(
    (rule) => rule.target === "role" && member.roles.cache.has(String(rule.target_id)),
  );
  if (roleRules.length) {
    const best = roleRules.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    return { seconds: best.seconds, source: "role", rule: best };
  }

  if (config.individual_default_seconds > 0) {
    return { seconds: config.individual_default_seconds, source: "default" };
  }

  return { seconds: 0, source: "none" };
}

export function describeResolvedDelay(resolved: ResolvedSlowmodeDelay, t: Translator): string {
  if (resolved.source === "none" || resolved.seconds <= 0) return t("slowmode.noIndividualSlowmode", "no individual slowmode");
  if (resolved.source === "default") return t("slowmode.defaultDelay", "default (**{seconds}**)", { seconds: formatSeconds(resolved.seconds, t) });
  if (resolved.source === "user" && resolved.rule) {
    return t("slowmode.userRuleDelay", "user rule #{id} (**{seconds}**)", { id: resolved.rule.id, seconds: formatSeconds(resolved.seconds, t) });
  }
  if (resolved.source === "role" && resolved.rule) {
    return t("slowmode.roleRuleDelay", "role <@&{roleId}> · rule #{id} (**{seconds}**)", {
      roleId: resolved.rule.target_id,
      id: resolved.rule.id,
      seconds: formatSeconds(resolved.seconds, t),
    });
  }
  return `**${formatSeconds(resolved.seconds, t)}**`;
}
