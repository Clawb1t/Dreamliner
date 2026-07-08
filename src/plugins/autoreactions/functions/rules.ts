import { z } from "zod";
import { zAutoreactionsConfig } from "../../../config/schemas/plugins.js";

export type AutoreactionRule = {
  id: number;
  channel_id: string;
  emoji: string;
  regex?: string;
};

type AutoreactionsConfig = z.infer<typeof zAutoreactionsConfig>;

export function normalizeAutoreactionRules(
  rules: AutoreactionsConfig["rules"],
): AutoreactionRule[] {
  let nextId = 1;
  const used = new Set<number>();

  return rules.map((rule) => {
    let id = rule.id;
    if (!id || used.has(id)) {
      while (used.has(nextId)) nextId++;
      id = nextId++;
    }
    used.add(id);
    return {
      id,
      channel_id: rule.channel_id,
      emoji: rule.emoji,
      ...(rule.regex ? { regex: rule.regex } : {}),
    };
  });
}

export function nextAutoreactionRuleId(rules: AutoreactionRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}
