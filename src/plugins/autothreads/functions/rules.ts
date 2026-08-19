import { z } from "zod";
import { zAutothreadsConfig, zAutothreadTrigger } from "../../../config/schemas/plugins.js";
import type { PersistButton, PersistEmbedConfig, PersistSticky } from "../../../config/schemas/persist.js";
import {
  contentMatchesTrigger,
  messagePassesFilters as baseMessagePassesFilters,
  resolveAutoreactionChannelId,
} from "../../autoreactions/functions/rules.js";
import { stickyHasContent } from "../../persist/functions/messageBuilder.js";

export type AutothreadTrigger = z.infer<typeof zAutothreadTrigger>;

export const THREAD_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;
export type ThreadArchiveMinutes = (typeof THREAD_ARCHIVE_MINUTES)[number];

export type AutothreadRule = {
  id: number;
  channel_id: string;
  thread_name: string;
  auto_archive_minutes: ThreadArchiveMinutes;
  thread_slowmode_seconds?: number;
  response: string;
  trigger: AutothreadTrigger;
  match?: string;
  every_n?: number;
  cooldown_seconds?: number;
  attachments_only?: boolean;
  links_only?: boolean;
  embed?: PersistEmbedConfig;
  buttons?: PersistButton[];
  webhook?: boolean;
  webhook_name?: string;
  webhook_avatar_url?: string;
  silent?: boolean;
  suppress_embeds?: boolean;
  mention_users?: boolean;
  mention_roles?: boolean;
  mention_everyone?: boolean;
};

type AutothreadsConfig = z.infer<typeof zAutothreadsConfig>;

const DEFAULT_EMBED: PersistEmbedConfig = {
  enabled: false,
  title: "",
  title_url: "",
  description: "",
  color: 0x5662f5,
  author_name: "",
  author_url: "",
  author_icon: "none",
  author_icon_url: "",
  thumbnail: "none",
  thumbnail_url: "",
  image_url: "",
  footer_text: "",
  footer_icon: "none",
  footer_icon_url: "",
  timestamp: false,
  fields: [],
};

function isArchiveMinutes(value: number): value is ThreadArchiveMinutes {
  return (THREAD_ARCHIVE_MINUTES as readonly number[]).includes(value);
}

export function normalizeAutothreadRules(rules: AutothreadsConfig["rules"]): AutothreadRule[] {
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
    const trigger: AutothreadTrigger = rule.trigger ?? "every_message";
    const archiveRaw = rule.auto_archive_minutes;
    const auto_archive_minutes: ThreadArchiveMinutes = isArchiveMinutes(archiveRaw) ? archiveRaw : 1440;
    const slowmode = rule.thread_slowmode_seconds;

    return {
      id,
      channel_id: resolveAutoreactionChannelId(rule.channel_id),
      thread_name: rule.thread_name || "{user_display}",
      auto_archive_minutes,
      ...(slowmode && slowmode > 0 ? { thread_slowmode_seconds: slowmode } : {}),
      response: rule.response ?? "",
      trigger,
      ...(match ? { match } : {}),
      ...(rule.every_n ? { every_n: rule.every_n } : {}),
      ...(rule.cooldown_seconds ? { cooldown_seconds: rule.cooldown_seconds } : {}),
      ...(rule.attachments_only ? { attachments_only: true } : {}),
      ...(rule.links_only ? { links_only: true } : {}),
      embed: rule.embed ?? { ...DEFAULT_EMBED },
      buttons: rule.buttons ?? [],
      ...(rule.webhook ? { webhook: true } : {}),
      ...(rule.webhook_name?.trim() ? { webhook_name: rule.webhook_name.trim() } : {}),
      ...(rule.webhook_avatar_url?.trim() ? { webhook_avatar_url: rule.webhook_avatar_url.trim() } : {}),
      ...(rule.silent ? { silent: true } : {}),
      ...(rule.suppress_embeds ? { suppress_embeds: true } : {}),
      mention_users: rule.mention_users !== false,
      mention_roles: rule.mention_roles !== false,
      ...(rule.mention_everyone ? { mention_everyone: true } : {}),
    };
  });
}

export function nextAutothreadRuleId(rules: AutothreadRule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

export function formatAutothreadRule(rule: AutothreadRule): string {
  const parts: string[] = [];
  if (rule.trigger === "every_message") parts.push("every message");
  else parts.push(`${rule.trigger} \`${rule.match ?? ""}\``);
  parts.push(`archive ${rule.auto_archive_minutes}m`);
  if (rule.every_n) parts.push(`every ${rule.every_n} msgs`);
  if (rule.cooldown_seconds) parts.push(`${rule.cooldown_seconds}s cooldown`);
  if (rule.attachments_only) parts.push("attachments only");
  if (rule.links_only) parts.push("links only");
  if (rule.webhook) parts.push("webhook");
  if (rule.embed?.enabled) parts.push("embed");
  return parts.join(" · ");
}

export function autothreadPassesFilters(
  message: { content: string | null; attachments: { size: number } },
  rule: AutothreadRule,
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

export function autothreadAsSticky(rule: AutothreadRule): PersistSticky {
  return {
    enabled: true,
    name: rule.webhook_name?.trim() || "Autothread",
    channel_id: rule.channel_id,
    content: rule.response,
    delay_seconds: 0,
    embed: rule.embed ?? { ...DEFAULT_EMBED },
    buttons: rule.buttons ?? [],
    webhook: Boolean(rule.webhook),
    webhook_name: rule.webhook_name ?? "",
    webhook_avatar_url: rule.webhook_avatar_url ?? "",
    silent: Boolean(rule.silent),
    suppress_embeds: Boolean(rule.suppress_embeds),
    mention_users: rule.mention_users !== false,
    mention_roles: rule.mention_roles !== false,
    mention_everyone: Boolean(rule.mention_everyone),
    ignore_bots: false,
    ignore_webhooks: false,
  };
}

export function autothreadHasContent(rule: AutothreadRule): boolean {
  return stickyHasContent(autothreadAsSticky(rule));
}

export { contentMatchesTrigger };
