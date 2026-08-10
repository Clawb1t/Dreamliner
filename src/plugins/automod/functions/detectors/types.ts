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

export { normalizeForMatch } from "./wordMatch.js";
