import type { Message } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zCensorConfig, type CensorConfig } from "../../../config/schemas/plugins.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { contentMatchesPattern } from "../../../core/rules.js";
import { buildCensorLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { censorDefaultOverrides } from "../defaultOverrides.js";
import { listCensorRules } from "./store.js";

type CensorRule = { pattern: string; regex: boolean; action: "delete" | "warn" };

async function getAllRules(guildId: string, config: CensorConfig): Promise<CensorRule[]> {
  const dbRules = await listCensorRules(guildId);
  const configRules = config.rules.map((r) => ({
    pattern: r.pattern,
    regex: r.regex,
    action: r.action as "delete" | "warn",
  }));
  const storedRules = dbRules.map((r) => ({
    pattern: r.pattern,
    regex: r.regex,
    action: (r.action === "warn" ? "warn" : "delete") as "delete" | "warn",
  }));
  return [...configRules, ...storedRules];
}

function channelRef(message: Message) {
  const name = "name" in message.channel ? (message.channel.name ?? message.channel.id) : message.channel.id;
  return { id: message.channel.id, name };
}

async function logCensor(message: Message, guildConfig: GuildConfig, pattern: string, action: string): Promise<void> {
  if (!message.author) return;
  await sendModerationLog(
    message.client,
    guildConfig,
    buildCensorLog({
      user: {
        id: message.author.id,
        name: message.author.username,
        avatarUrl: message.author.displayAvatarURL({ size: 128 }),
      },
      channel: channelRef(message),
      pattern,
      action,
    }),
  );
}

async function applyCensorAction(
  message: Message,
  guildConfig: GuildConfig,
  action: "delete" | "warn",
  pattern: string,
): Promise<void> {
  if (action === "delete") {
    await message.delete().catch(() => null);
    await logCensor(message, guildConfig, pattern, action);
    return;
  }
  await message.author
    .send(`Your message in **${message.guild?.name}** matched censored pattern \`${pattern.slice(0, 100)}\`.`)
    .catch(() => null);
  await logCensor(message, guildConfig, pattern, action);
}

export async function handleCensorMessage(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.content) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "censor")) return;

  const config = zCensorConfig.parse(
    resolvePluginConfig(
      guildConfig,
      "censor",
      censorDefaultOverrides,
      message.member ?? undefined,
      message.channel.id,
    ),
  );

  if (config.ignored_channels.includes(message.channel.id)) return;

  const rules = await getAllRules(message.guild.id, config);
  for (const rule of rules) {
    if (contentMatchesPattern(message.content, rule.pattern, rule.regex)) {
      await applyCensorAction(message, guildConfig, rule.action, rule.pattern);
      return;
    }
  }
}

export async function handleCensorMessageUpdate(
  _oldMessage: Message | import("discord.js").PartialMessage,
  newMessage: Message | import("discord.js").PartialMessage,
): Promise<void> {
  if (newMessage.partial) {
    try {
      await newMessage.fetch();
    } catch {
      return;
    }
  }
  if (!newMessage.guild || newMessage.author?.bot || !newMessage.content) return;
  await handleCensorMessage(newMessage as Message);
}
