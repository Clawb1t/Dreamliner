import { z } from "zod";
import { zAutoreactionsConfig, zAutoreactionTrigger } from "../../../config/schemas/plugins.js";
import { userRegexMatches } from "../../../core/userRegex.js";

export type AutoreactionTrigger = z.infer<typeof zAutoreactionTrigger>;

export type AutoreactionRule = {
  id: number;
  channel_id: string;
  emoji: string;
  trigger: AutoreactionTrigger;
  match?: string;
  every_n?: number;
  cooldown_seconds?: number;
  attachments_only?: boolean;
  links_only?: boolean;
};

type AutoreactionsConfig = z.infer<typeof zAutoreactionsConfig>;

export const AUTOREACTION_ALL_CHANNELS = "*";

export function resolveAutoreactionChannelId(channelId: string | undefined): string {
  const trimmed = channelId?.trim();
  return !trimmed || trimmed === AUTOREACTION_ALL_CHANNELS ? AUTOREACTION_ALL_CHANNELS : trimmed;
}

export function normalizeAutoreactionRules(rules: AutoreactionsConfig["rules"]): AutoreactionRule[] {
  let nextId = 1;
  const used = new Set<number>();

  return rules.map((rule) => {
    let id = rule.id;
    if (!id || used.has(id)) {
      while (used.has(nextId)) nextId++;
      id = nextId++;
    }
    used.add(id);

    const legacyRegex = rule.regex?.trim();
    const match = rule.match?.trim() || legacyRegex || undefined;
    let trigger: AutoreactionTrigger = rule.trigger ?? (legacyRegex ? "regex" : "every_message");
    if (!rule.trigger && legacyRegex) trigger = "regex";

    return {
      id,
      channel_id: resolveAutoreactionChannelId(rule.channel_id),
      emoji: rule.emoji,
      trigger,
      ...(match ? { match } : {}),
      ...(rule.every_n ? { every_n: rule.every_n } : {}),
      ...(rule.cooldown_seconds ? { cooldown_seconds: rule.cooldown_seconds } : {}),
      ...(rule.attachments_only ? { attachments_only: true } : {}),
      ...(rule.links_only ? { links_only: true } : {}),
    };
  });
}

export function nextAutoreactionRuleId(rules: AutoreactionRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

export function formatAutoreactionRule(rule: AutoreactionRule): string {
  const parts: string[] = [];
  if (rule.trigger === "every_message") parts.push("every message");
  else parts.push(`${rule.trigger} \`${rule.match ?? ""}\``);
  if (rule.every_n) parts.push(`every ${rule.every_n} msgs`);
  if (rule.cooldown_seconds) parts.push(`${rule.cooldown_seconds}s cooldown`);
  if (rule.attachments_only) parts.push("attachments only");
  if (rule.links_only) parts.push("links only");
  return parts.join(" · ");
}

export function contentMatchesTrigger(content: string, trigger: AutoreactionTrigger, match?: string): boolean {
  if (trigger === "every_message") return true;
  if (!match) return false;

  if (trigger === "regex") {
    return userRegexMatches(content, match);
  }

  const haystack = content.toLowerCase();
  const needle = match.toLowerCase();
  if (trigger === "contains") return haystack.includes(needle);
  if (trigger === "starts_with") return haystack.startsWith(needle);
  if (trigger === "exact") return haystack === needle;
  return false;
}

const LINK_RE = /https?:\/\/\S+/i;

export function messagePassesFilters(
  message: { content: string | null; attachments: { size: number } },
  rule: AutoreactionRule,
): boolean {
  if (rule.attachments_only && message.attachments.size === 0) return false;
  if (rule.links_only && !LINK_RE.test(message.content ?? "")) return false;
  return contentMatchesTrigger(message.content ?? "", rule.trigger, rule.match);
}
