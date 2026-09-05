import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  PermissionFlagsBits,
  type AutoModerationActionExecution,
  type AutoModerationRule,
  type Client,
} from "discord.js";
import type { AutomodConfig } from "../../../config/schemas/automod.js";
import { configManager } from "../../../config/manager.js";
import { buildAutomodLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { parseAutomodConfig, mergeCensorDbRulesIntoConfig } from "./migrate.js";
import { parseFilterEntries } from "./customFilter.js";

/** Every rule Dreamliner creates in a guild's native AutoMod is named with this prefix,
 * followed by a stable `[key]` suffix, so a resync can tell "ours to manage" apart from
 * anything staff created by hand in Discord's own settings, and can match an existing
 * rule back to the desired definition that produced it. */
const NAME_PREFIX = "Dreamliner AutoMod";
const KEY_RE = /\[([a-z0-9_-]+)\]$/i;

// Discord's own limits (auto-moderation), enforced client-side so we fail predictably
// instead of letting the API 400 on us mid-sync.
const MAX_KEYWORD_RULES = 6;
const MAX_KEYWORDS_PER_RULE = 1000;
const MAX_KEYWORD_LENGTH = 60;
const MAX_REGEX_PER_RULE = 10;
const MAX_REGEX_LENGTH = 260;
const MAX_EXEMPT_ROLES = 20;
const MAX_EXEMPT_CHANNELS = 50;
const MAX_MENTION_LIMIT = 50;

type DesiredRule = {
  key: string;
  label: string;
  eventType: AutoModerationRuleEventType;
  triggerType: AutoModerationRuleTriggerType;
  triggerMetadata: Record<string, unknown>;
  actions: Array<{ type: AutoModerationActionType; metadata?: Record<string, unknown> }>;
  exemptRoles: string[];
  exemptChannels: string[];
};

export type NativeRuleStatus = {
  key: string;
  name: string;
  triggerType: string;
  enabled: boolean;
  synced: boolean;
  error?: string;
};

export type NativeSyncResult = {
  ok: boolean;
  supported: boolean;
  enabled: boolean;
  error?: string;
  rules: NativeRuleStatus[];
  syncedAt: string;
};

function invitePattern(): string {
  return "(discord\\.(gg|io|me|li)|discord(?:app)?\\.com\\/invite)\\/[a-z0-9-]+";
}

function nameFor(label: string, key: string): string {
  const name = `${NAME_PREFIX}: ${label} [${key}]`;
  return name.length > 100 ? name.slice(0, 97) + "…]".slice(0, 100 - name.length + 3) : name;
}

function keyFromName(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  return KEY_RE.exec(name)?.[1] ?? null;
}

function clampExempt(roles: string[], channels: string[]) {
  return {
    exemptRoles: [...new Set(roles)].slice(0, MAX_EXEMPT_ROLES),
    exemptChannels: [...new Set(channels)].slice(0, MAX_EXEMPT_CHANNELS),
  };
}

function baseActions(
  config: AutomodConfig,
  label: string,
  opts: { allowTimeout: boolean },
): DesiredRule["actions"] {
  const actions: DesiredRule["actions"] = [
    {
      type: AutoModerationActionType.BlockMessage,
      metadata: { customMessage: `Blocked by Dreamliner AutoMod — ${label}`.slice(0, 150) },
    },
  ];
  if (config.native.alert_channel_id) {
    actions.push({
      type: AutoModerationActionType.SendAlertMessage,
      metadata: { channelId: config.native.alert_channel_id },
    });
  }
  if (opts.allowTimeout && config.native.timeout_seconds > 0) {
    actions.push({
      type: AutoModerationActionType.Timeout,
      metadata: { durationSeconds: config.native.timeout_seconds },
    });
  }
  return actions;
}

/** Build the full set of native rules Dreamliner *wants* to exist for this config.
 * Only rule ids Discord's native triggers can actually represent are mirrored — the
 * rest (nuanced spam/caps/zalgo/link-list heuristics) stay bot-side only. */
export function buildDesiredNativeRules(config: AutomodConfig): DesiredRule[] {
  if (!config.native.enabled) return [];
  const desired: DesiredRule[] = [];
  const { exemptRoles, exemptChannels } = clampExempt(config.ignored_roles, config.ignored_channels);

  const profanity = config.rules.profanity;
  const slurs = config.rules.slurs;
  if (profanity?.enabled || slurs?.enabled) {
    const presets: AutoModerationRuleKeywordPresetType[] = [];
    if (profanity?.enabled) presets.push(AutoModerationRuleKeywordPresetType.Profanity);
    if (slurs?.enabled) presets.push(AutoModerationRuleKeywordPresetType.Slurs);
    desired.push({
      key: "preset",
      label: "Profanity & slurs",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.KeywordPreset,
      triggerMetadata: { presets, allowList: [] },
      actions: baseActions(config, "Profanity & slurs", { allowTimeout: true }),
      exemptRoles: [...exemptRoles, ...(profanity?.ignored_roles ?? []), ...(slurs?.ignored_roles ?? [])],
      exemptChannels: [
        ...exemptChannels,
        ...(profanity?.ignored_channels ?? []),
        ...(slurs?.ignored_channels ?? []),
      ],
    });
  }

  // Keyword-based rules: custom filter words/regex, invite links, literal @everyone/@here
  // text. Chunked across multiple KEYWORD rules to respect Discord's 1000-keyword /
  // 10-regex-per-rule caps, and capped overall at Discord's 6-KEYWORD-rules-per-guild limit.
  const customFilter = config.rules.custom_filter;
  const invites = config.rules.invites;
  const everyoneHere = config.rules.everyone_here;

  const keywords: string[] = [];
  const regexes: string[] = [];
  if (customFilter?.enabled) {
    for (const entry of parseFilterEntries(customFilter.settings)) {
      if (!entry.enabled || !entry.pattern.trim()) continue;
      if (entry.regex) {
        if (entry.pattern.length <= MAX_REGEX_LENGTH) regexes.push(entry.pattern);
      } else if (entry.pattern.length <= MAX_KEYWORD_LENGTH) {
        keywords.push(entry.pattern);
      }
    }
  }
  if (everyoneHere?.enabled) {
    keywords.push("@everyone", "@here");
  }
  if (invites?.enabled) {
    regexes.push(invitePattern());
  }

  if (keywords.length || regexes.length) {
    const keywordChunks = chunk(keywords, MAX_KEYWORDS_PER_RULE);
    const regexChunks = chunk(regexes, MAX_REGEX_PER_RULE);
    const pageCount = Math.max(keywordChunks.length, regexChunks.length, 1);
    for (let i = 0; i < pageCount && i < MAX_KEYWORD_RULES; i++) {
      const kws = keywordChunks[i] ?? [];
      const rxs = i === 0 ? (regexChunks[0] ?? []) : (regexChunks[i] ?? []);
      if (!kws.length && !rxs.length) continue;
      const label = pageCount > 1 ? `Custom filters & links (${i + 1}/${pageCount})` : "Custom filters & links";
      desired.push({
        key: `keywords-${i + 1}`,
        label,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter: kws, regexPatterns: rxs, allowList: [] },
        actions: baseActions(config, label, { allowTimeout: true }),
        exemptRoles: [
          ...exemptRoles,
          ...(customFilter?.ignored_roles ?? []),
          ...(invites?.ignored_roles ?? []),
          ...(everyoneHere?.ignored_roles ?? []),
        ],
        exemptChannels: [
          ...exemptChannels,
          ...(customFilter?.ignored_channels ?? []),
          ...(invites?.ignored_channels ?? []),
          ...(everyoneHere?.ignored_channels ?? []),
        ],
      });
    }
  }

  const massMentions = config.rules.mass_mentions;
  if (massMentions?.enabled) {
    const limit = Math.min(
      MAX_MENTION_LIMIT,
      Math.max(1, Number(massMentions.settings.max_mentions ?? 5)),
    );
    desired.push({
      key: "mention-spam",
      label: "Mass mentions",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: limit, mentionRaidProtectionEnabled: true },
      actions: baseActions(config, "Mass mentions", { allowTimeout: true }),
      exemptRoles: [...exemptRoles, ...(massMentions.ignored_roles ?? [])],
      exemptChannels: [...exemptChannels, ...(massMentions.ignored_channels ?? [])],
    });
  }

  if (config.native.spam_detection) {
    desired.push({
      key: "spam",
      label: "Spam (Discord ML)",
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Spam,
      triggerMetadata: {},
      // Discord does not allow Timeout on the SPAM trigger type — block/alert only.
      actions: baseActions(config, "Spam (Discord ML)", { allowTimeout: false }),
      exemptRoles,
      exemptChannels,
    });
  }

  return desired;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sameDefinition(existing: AutoModerationRule, desired: DesiredRule): boolean {
  const a = {
    triggerMetadata: existing.triggerMetadata,
    actions: existing.actions.map((a) => ({ type: a.type, metadata: a.metadata })),
    exemptRoles: [...existing.exemptRoles.keys()].sort(),
    exemptChannels: [...existing.exemptChannels.keys()].sort(),
    enabled: existing.enabled,
  };
  const b = {
    triggerMetadata: desired.triggerMetadata,
    actions: desired.actions,
    exemptRoles: [...desired.exemptRoles].sort(),
    exemptChannels: [...desired.exemptChannels].sort(),
    enabled: true,
  };
  return JSON.stringify(a) === JSON.stringify(b);
}

async function loadConfigForGuild(guildId: string): Promise<AutomodConfig> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  let config = parseAutomodConfig(guildConfig.plugins.automod?.config ?? {});
  config = await mergeCensorDbRulesIntoConfig(guildId, config);
  return config;
}

async function deleteOwnedRules(existing: AutoModerationRule[]): Promise<NativeRuleStatus[]> {
  const results: NativeRuleStatus[] = [];
  for (const rule of existing) {
    const key = keyFromName(rule.name);
    if (!key) continue;
    try {
      await rule.delete("Dreamliner: native AutoMod sync disabled");
      results.push({ key, name: rule.name, triggerType: String(rule.triggerType), enabled: false, synced: true });
    } catch (error) {
      results.push({
        key,
        name: rule.name,
        triggerType: String(rule.triggerType),
        enabled: rule.enabled,
        synced: false,
        error: error instanceof Error ? error.message : "Failed to delete",
      });
    }
  }
  return results;
}

/** Reconcile a guild's native Discord AutoMod rules with its Dreamliner automod config.
 * Idempotent and safe to call repeatedly (on save, on a manual "sync now", and once per
 * guild at boot) — only touches rules this function itself created (matched by name). */
export async function syncNativeAutomodRules(
  client: Client,
  guildId: string,
  configOverride?: AutomodConfig,
): Promise<NativeSyncResult> {
  const syncedAt = new Date().toISOString();
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return { ok: false, supported: false, enabled: false, error: "Bot is not in that server.", rules: [], syncedAt };
  }
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return {
      ok: false,
      supported: false,
      enabled: false,
      error: "Dreamliner needs the Manage Server permission in this server to manage native AutoMod rules. Re-invite the bot to grant it.",
      rules: [],
      syncedAt,
    };
  }

  const config = configOverride ?? (await loadConfigForGuild(guildId));

  let existing: AutoModerationRule[];
  try {
    existing = [...(await guild.autoModerationRules.fetch()).values()];
  } catch (error) {
    return {
      ok: false,
      supported: true,
      enabled: config.native.enabled,
      error: error instanceof Error ? error.message : "Failed to read existing AutoMod rules.",
      rules: [],
      syncedAt,
    };
  }
  const owned = existing.filter((r) => keyFromName(r.name));

  if (!config.native.enabled) {
    const rules = await deleteOwnedRules(owned);
    return { ok: true, supported: true, enabled: false, rules, syncedAt };
  }

  const desired = buildDesiredNativeRules(config);
  const desiredKeys = new Set(desired.map((d) => d.key));
  const results: NativeRuleStatus[] = [];

  // Delete anything we own that's no longer wanted.
  for (const rule of owned) {
    const key = keyFromName(rule.name)!;
    if (desiredKeys.has(key)) continue;
    try {
      await rule.delete("Dreamliner: rule no longer configured");
    } catch {
      // best-effort; will retry next sync
    }
  }

  for (const d of desired) {
    const name = nameFor(d.label, d.key);
    const match = owned.find((r) => keyFromName(r.name) === d.key);
    try {
      if (!match) {
        await guild.autoModerationRules.create({
          name,
          eventType: d.eventType,
          triggerType: d.triggerType,
          triggerMetadata: d.triggerMetadata,
          actions: d.actions,
          enabled: true,
          exemptRoles: d.exemptRoles,
          exemptChannels: d.exemptChannels,
          reason: "Dreamliner: native AutoMod sync",
        });
      } else if (match.name !== name || !sameDefinition(match, d)) {
        await match.edit({
          name,
          triggerMetadata: d.triggerMetadata,
          actions: d.actions,
          enabled: true,
          exemptRoles: d.exemptRoles,
          exemptChannels: d.exemptChannels,
          reason: "Dreamliner: native AutoMod sync",
        });
      }
      results.push({ key: d.key, name, triggerType: String(d.triggerType), enabled: true, synced: true });
    } catch (error) {
      results.push({
        key: d.key,
        name,
        triggerType: String(d.triggerType),
        enabled: true,
        synced: false,
        error: error instanceof Error ? error.message : "Failed to sync rule.",
      });
    }
  }

  return { ok: true, supported: true, enabled: true, rules: results, syncedAt };
}

/** Read-only view of what's currently live, without creating/editing/deleting anything.
 * Used by the dashboard to render status without mutating state on every page load. */
export async function getNativeAutomodStatus(
  client: Client,
  guildId: string,
): Promise<Omit<NativeSyncResult, "ok"> & { ok: boolean }> {
  const syncedAt = new Date().toISOString();
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return { ok: false, supported: false, enabled: false, error: "Bot is not in that server.", rules: [], syncedAt };
  }
  const supported = Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));
  const config = await loadConfigForGuild(guildId);
  if (!supported) {
    return {
      ok: true,
      supported: false,
      enabled: config.native.enabled,
      error: "Dreamliner needs the Manage Server permission in this server to manage native AutoMod rules. Re-invite the bot to grant it.",
      rules: [],
      syncedAt,
    };
  }
  try {
    const existing = [...(await guild.autoModerationRules.fetch()).values()].filter((r) => keyFromName(r.name));
    return {
      ok: true,
      supported: true,
      enabled: config.native.enabled,
      rules: existing.map((r) => ({
        key: keyFromName(r.name)!,
        name: r.name,
        triggerType: String(r.triggerType),
        enabled: r.enabled,
        synced: true,
      })),
      syncedAt,
    };
  } catch (error) {
    return {
      ok: false,
      supported: true,
      enabled: config.native.enabled,
      error: error instanceof Error ? error.message : "Failed to read AutoMod rules.",
      rules: [],
      syncedAt,
    };
  }
}

/** Called once at boot for every guild with native sync turned on, so drift from a
 * manual edit in Discord's own settings (or a rule someone deleted by hand) self-heals
 * without staff having to remember to hit "Sync now". Best-effort; errors are swallowed
 * per-guild so one bad guild can't block the others. */
export async function resyncAllNativeAutomod(client: Client): Promise<void> {
  for (const guildId of client.guilds.cache.keys()) {
    try {
      const config = await loadConfigForGuild(guildId);
      if (!config.native.enabled) continue;
      await syncNativeAutomodRules(client, guildId, config);
    } catch (error) {
      console.warn(`[automod] Native AutoMod resync failed for guild ${guildId}:`, error);
    }
  }
}

const LABEL_BY_KEY: Record<string, string> = {
  preset: "Profanity & slurs (native)",
  "mention-spam": "Mass mentions (native)",
  spam: "Spam — Discord ML (native)",
};

function labelForExecution(execution: AutoModerationActionExecution): string {
  const name = execution.autoModerationRule?.name;
  const key = name ? keyFromName(name) : null;
  if (key && LABEL_BY_KEY[key]) return LABEL_BY_KEY[key];
  if (key?.startsWith("keywords-")) return "Custom filters & links (native)";
  return "Discord AutoMod (native)";
}

/** Discord blocked/timed-out/alerted on a message via one of *our* native rules. We
 * don't have message content or points-ladder context the way our own detectors do
 * (Discord already handled the enforcement), so this only mirrors the hit into
 * Dreamliner's own moderation log for visibility — it does not double-punish or feed
 * the strike ladder. Ignores rules Dreamliner didn't create (name has no `[key]`). */
export async function handleNativeAutomodExecution(execution: AutoModerationActionExecution): Promise<void> {
  const name = execution.autoModerationRule?.name;
  if (!name || !keyFromName(name)) return;
  if (execution.action.type !== AutoModerationActionType.BlockMessage) return;

  const guild = execution.guild;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const config = parseAutomodConfig(guildConfig.plugins.automod?.config ?? {});
  const user = execution.member?.user ?? execution.user ?? (await guild.client.users.fetch(execution.userId).catch(() => null));
  if (!user) return;

  const liveChannel = execution.channel;
  const channelRef = execution.channelId
    ? { id: execution.channelId, name: (liveChannel && "name" in liveChannel ? liveChannel.name : null) ?? execution.channelId }
    : { id: guild.id, name: guild.name };

  await sendModerationLog(
    guild.client,
    guildConfig,
    buildAutomodLog({
      user: { id: user.id, name: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) },
      channel: channelRef,
      reason: labelForExecution(execution),
      action: "block (native)",
      content: execution.matchedContent ?? execution.matchedKeyword ?? undefined,
    }),
    {
      guildId: guild.id,
      eventType: "automod",
      actorId: user.id,
      targetId: user.id,
      channelId: execution.channelId ?? undefined,
      messageId: execution.messageId ?? undefined,
      caseLogOverride: config.log_channel_id,
    },
  );
}
