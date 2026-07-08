import type { Message } from "discord.js";
import type { CustomEventConfig, CustomEventRecord } from "./store.js";

export function messageMatchesEvent(message: Message, event: CustomEventRecord): boolean {
  if (!message.guild || message.author.bot) return false;
  if (event.triggerType !== "message") return false;

  const config = event.config;
  if (config.channels?.length && !config.channels.includes(message.channelId)) return false;

  const content = message.content ?? "";
  const match = config.match?.trim();
  if (!match) return false;

  if (config.regex) {
    try {
      const flags = config.case_sensitive ? "" : "i";
      const re = new RegExp(match, flags);
      return re.test(content);
    } catch {
      return false;
    }
  }

  const haystack = config.case_sensitive ? content : content.toLowerCase();
  const needle = config.case_sensitive ? match : match.toLowerCase();
  return haystack.includes(needle);
}

export function formatEventConfig(config: CustomEventConfig): string {
  const parts: string[] = [];
  if (config.match) parts.push(`match: \`${config.match}\``);
  if (config.regex) parts.push("regex");
  if (config.case_sensitive) parts.push("case-sensitive");
  if (config.channels?.length) parts.push(`channels: ${config.channels.map((id) => `<#${id}>`).join(", ")}`);
  return parts.length ? parts.join(" · ") : "No filters";
}

export function buildDefaultMessageConfig(match: string): CustomEventConfig {
  return { match, regex: false, case_sensitive: false };
}
