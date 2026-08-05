import type { GuildMember } from "discord.js";
import type { SlowmodeConfig, SlowmodeRuleTarget } from "../../../config/schemas/plugins.js";
import { formatDuration } from "../../../core/datetime.js";

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

export function formatChannelScope(channels: string[]): string {
  if (!channels.length || channels.includes(ALL_CHANNELS)) return "All channels";
  return channels.map((id) => `<#${id}>`).join(", ");
}

export function formatSlowmodeRule(rule: NormalizedSlowmodeRule): string {
  const target = rule.target === "user" ? `<@${rule.target_id}>` : `<@&${rule.target_id}>`;
  return `**#${rule.id}** · ${rule.target} ${target} · **${formatSeconds(rule.seconds)}** · ${formatChannelScope(rule.channels)}`;
}

export function formatSeconds(seconds: number): string {
  if (seconds <= 0) return "none";
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

export function describeResolvedDelay(resolved: ResolvedSlowmodeDelay): string {
  if (resolved.source === "none" || resolved.seconds <= 0) return "no individual slowmode";
  if (resolved.source === "default") return `default (**${formatSeconds(resolved.seconds)}**)`;
  if (resolved.source === "user" && resolved.rule) {
    return `user rule #${resolved.rule.id} (**${formatSeconds(resolved.seconds)}**)`;
  }
  if (resolved.source === "role" && resolved.rule) {
    return `role <@&${resolved.rule.target_id}> · rule #${resolved.rule.id} (**${formatSeconds(resolved.seconds)}**)`;
  }
  return `**${formatSeconds(resolved.seconds)}**`;
}
