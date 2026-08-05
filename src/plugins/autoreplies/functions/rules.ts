import { z } from "zod";
import { zAutorepliesConfig, zAutoreplyTrigger } from "../../../config/schemas/plugins.js";
import { contentMatchesTrigger, messagePassesFilters as baseMessagePassesFilters } from "../../autoreactions/functions/rules.js";

export type AutoreplyTrigger = z.infer<typeof zAutoreplyTrigger>;

export type AutoreplyRule = {
  id: number;
  channel_id: string;
  response: string;
  trigger: AutoreplyTrigger;
  match?: string;
  every_n?: number;
  cooldown_seconds?: number;
  attachments_only?: boolean;
  links_only?: boolean;
  reply_to_message?: boolean;
};

type AutorepliesConfig = z.infer<typeof zAutorepliesConfig>;

export function normalizeAutoreplyRules(rules: AutorepliesConfig["rules"]): AutoreplyRule[] {
  let nextId = 1;
  const used = new Set<number>();

  return rules.map((rule) => {
    let id = rule.id;
    if (!id || used.has(id)) {
      while (used.has(nextId)) nextId++;
      id = nextId++;
    }
    used.add(id);

    const match = rule.match?.trim() || undefined;
    const trigger: AutoreplyTrigger = rule.trigger ?? "every_message";

    return {
      id,
      channel_id: rule.channel_id,
      response: rule.response,
      trigger,
      ...(match ? { match } : {}),
      ...(rule.every_n ? { every_n: rule.every_n } : {}),
      ...(rule.cooldown_seconds ? { cooldown_seconds: rule.cooldown_seconds } : {}),
      ...(rule.attachments_only ? { attachments_only: true } : {}),
      ...(rule.links_only ? { links_only: true } : {}),
      reply_to_message: rule.reply_to_message !== false,
    };
  });
}

export function nextAutoreplyRuleId(rules: AutoreplyRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

export function formatAutoreplyRule(rule: AutoreplyRule): string {
  const parts: string[] = [];
  if (rule.trigger === "every_message") parts.push("every message");
  else parts.push(`${rule.trigger} \`${rule.match ?? ""}\``);
  if (rule.every_n) parts.push(`every ${rule.every_n} msgs`);
  if (rule.cooldown_seconds) parts.push(`${rule.cooldown_seconds}s cooldown`);
  if (rule.attachments_only) parts.push("attachments only");
  if (rule.links_only) parts.push("links only");
  parts.push(rule.reply_to_message === false ? "send after" : "reply");
  return parts.join(" · ");
}

export function autoreplyPassesFilters(
  message: { content: string | null; attachments: { size: number } },
  rule: AutoreplyRule,
): boolean {
  return baseMessagePassesFilters(message, {
    id: rule.id,
    channel_id: rule.channel_id,
    emoji: "",
    trigger: rule.trigger,
    match: rule.match,
    attachments_only: rule.attachments_only,
    links_only: rule.links_only,
  });
}

export { contentMatchesTrigger };
