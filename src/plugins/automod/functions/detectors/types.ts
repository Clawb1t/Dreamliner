import type { GuildMember, Message } from "discord.js";
import type { AutomodConfig, AutomodRuleConfig, AutomodRuleId } from "../../../../config/schemas/automod.js";

export type AutomodHit = {
  ruleId: AutomodRuleId;
  reason: string;
  detail?: string;
};

export type AutomodMessageContext = {
  kind: "message";
  message: Message;
  member: GuildMember | null;
  config: AutomodConfig;
  content: string;
  normalized: string;
};

export type AutomodJoinContext = {
  kind: "join";
  member: GuildMember;
  config: AutomodConfig;
};

export type AutomodContext = AutomodMessageContext | AutomodJoinContext;

export type Detector = (
  ctx: AutomodContext,
  rule: AutomodRuleConfig,
) => AutomodHit | null | Promise<AutomodHit | null>;

export function numSetting(rule: AutomodRuleConfig, key: string, fallback: number): number {
  const value = rule.settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function boolSetting(rule: AutomodRuleConfig, key: string, fallback: boolean): boolean {
  const value = rule.settings[key];
  return typeof value === "boolean" ? value : fallback;
}

export function stringListSetting(rule: AutomodRuleConfig, key: string): string[] {
  const value = rule.settings[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function sensitivityMultiplier(rule: AutomodRuleConfig): number {
  switch (rule.sensitivity) {
    case "lenient":
      return 1.35;
    case "strict":
      return 0.7;
    case "custom":
    case "balanced":
    default:
      return 1;
  }
}

/** Pulls hostnames out of a message's http(s) links, lowercased and de-duplicated, skipping
 * anything that doesn't parse as a URL. Shared by Link Spam and Domain Intelligence so both
 * see the same set of links in a message. */
const URL_RE = /https?:\/\/[^\s<>]+/gi;

export function extractHosts(content: string): string[] {
  const urls = content.match(URL_RE) ?? [];
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.toLowerCase());
    } catch {
      /* ignore unparseable URL */
    }
  }
  return [...hosts];
}

export { normalizeForMatch } from "./wordMatch.js";
