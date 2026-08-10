import type { GuildMember, Message } from "discord.js";
import type { AutomodConfig, AutomodRuleConfig } from "../../../config/schemas/automod.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { getMemberLevel, resolvePluginConfig } from "../../../core/permissions.js";
import { buildRaidDetectedLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { automodDefaultOverrides } from "../defaultOverrides.js";
import { applyAutomodHit } from "./actions.js";
import {
  buildMessageContext,
  runJoinDetectors,
  runMessageDetectors,
} from "./detectors/index.js";
import { mergeCensorDbRulesIntoConfig, parseAutomodConfig } from "./migrate.js";
import { countAutomodHits, recordAutomodHit } from "./strikes.js";

function isIgnored(
  member: GuildMember | null,
  config: AutomodConfig,
  guildConfig: GuildConfig,
  channelId?: string,
): boolean {
  if (channelId && config.ignored_channels.includes(channelId)) return true;
  if (!member) return false;
  if (config.ignored_roles.some((roleId) => member.roles.cache.has(roleId))) return true;
  if (config.ignore_above_level != null) {
    const level = getMemberLevel(member, guildConfig.levels);
    if (level >= config.ignore_above_level) return true;
  }
  return false;
}

function isRuleIgnored(
  member: GuildMember | null,
  rule: AutomodRuleConfig,
  channelId?: string,
): boolean {
  if (channelId && (rule.ignored_channels ?? []).includes(channelId)) return true;
  if (!member) return false;
  return (rule.ignored_roles ?? []).some((roleId) => member.roles.cache.has(roleId));
}

async function loadAutomodConfig(
  guildId: string,
  member?: GuildMember | null,
  channelId?: string,
): Promise<{ guildConfig: Awaited<ReturnType<typeof configManager.getEffectiveConfig>>; config: AutomodConfig } | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  // Automod defaults to off; require an explicit enabled: true.
  if (guildConfig.plugins.automod?.enabled !== true) return null;

  let config = parseAutomodConfig(
    resolvePluginConfig(guildConfig, "automod", automodDefaultOverrides, member ?? undefined, channelId),
  );
  config = await mergeCensorDbRulesIntoConfig(guildId, config);
  return { guildConfig, config };
}

export async function handleAutomodMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const loaded = await loadAutomodConfig(message.guild.id, message.member, message.channel.id);
  if (!loaded) return;
  const { guildConfig, config } = loaded;

  if (isIgnored(message.member, config, guildConfig, message.channel.id)) return;

  const ctx = buildMessageContext(message, config);
  const hit = await runMessageDetectors(ctx);
  if (!hit) return;

  const rule = config.rules[hit.ruleId];
  if (!rule) return;
  if (isRuleIgnored(message.member, rule, message.channel.id)) return;

  await recordAutomodHit({
    guildId: message.guild.id,
    userId: message.author.id,
    ruleId: hit.ruleId,
    channelId: message.channel.id,
    messageId: message.id,
  });
  const hitCount = await countAutomodHits({
    guildId: message.guild.id,
    userId: message.author.id,
    ruleId: hit.ruleId,
    windowMs: rule.strike_window_ms,
  });

  await applyAutomodHit({
    client: message.client,
    guildConfig,
    config,
    hit,
    hitCount,
    rule,
    message,
    member: message.member,
    user: message.author,
    guildId: message.guild.id,
  });
}

export async function handleAutomodMessageUpdate(
  _oldMessage: Message,
  newMessage: Message,
): Promise<void> {
  if (!newMessage.guild || newMessage.author?.bot) return;
  // Re-run content rules on edits (partial Message may need fetch)
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message || message.author.bot) return;
  await handleAutomodMessage(message);
}

export async function handleAutomodMemberAdd(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const loaded = await loadAutomodConfig(member.guild.id, member);
  if (!loaded) return;
  const { guildConfig, config } = loaded;

  if (isIgnored(member, config, guildConfig)) return;

  const hit = await runJoinDetectors({ kind: "join", member, config });
  if (!hit) return;

  const rule = config.rules.raid;
  if (!rule) return;
  if (isRuleIgnored(member, rule)) return;

  await recordAutomodHit({
    guildId: member.guild.id,
    userId: member.id,
    ruleId: "raid",
  });
  const hitCount = await countAutomodHits({
    guildId: member.guild.id,
    userId: member.id,
    ruleId: "raid",
    windowMs: rule.strike_window_ms,
  });

  // Always emit classic raid log card for visibility
  await sendModerationLog(
    member.client,
    guildConfig,
    buildRaidDetectedLog({
      user: {
        id: member.id,
        name: member.user.username,
        avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      },
      joinCount: Number(hit.detail?.match(/^(\d+)/)?.[1] ?? hitCount),
      windowMs: Number(rule.settings.join_window_ms ?? 30_000),
    }),
    {
      guildId: member.guild.id,
      eventType: "raid",
      actorId: member.id,
      targetId: member.id,
      caseLogOverride: config.log_channel_id,
    },
  );

  await applyAutomodHit({
    client: member.client,
    guildConfig,
    config,
    hit,
    hitCount,
    rule,
    member,
    user: member.user,
    guildId: member.guild.id,
  });
}

export async function testAutomodRules(sample: string, config: AutomodConfig): Promise<string[]> {
  const fakeMessage = {
    content: sample,
    author: { bot: false, id: "0" },
    member: null,
    guild: { id: "0" },
    channel: { id: "0" },
    mentions: { users: new Map(), everyone: /@everyone/i.test(sample) },
    stickers: { size: 0 },
    attachments: { size: 0, some: () => false },
    embeds: [],
  } as unknown as Message;

  const ctx = buildMessageContext(fakeMessage, config);
  // Bypass rate-limit style detectors that need real traffic; still run content detectors.
  const lines: string[] = [];
  const { DETECTORS, MESSAGE_RULE_ORDER } = await import("./detectors/index.js");
  for (const ruleId of MESSAGE_RULE_ORDER) {
    const rule = config.rules[ruleId];
    if (!rule?.enabled) continue;
    // Skip pure rate detectors in dry-run unless content-based
    if (["spam", "duplicate", "copypasta", "sticker_gif_spam", "attachment_spam"].includes(ruleId)) {
      continue;
    }
    const hit = await DETECTORS[ruleId](ctx, rule);
    if (hit) lines.push(`• **${hit.ruleId}** — ${hit.reason}${hit.detail ? ` (${hit.detail})` : ""}`);
  }
  if (!lines.length) lines.push("No enabled content rules matched this sample.");
  return lines;
}
