import type { Message } from "discord.js";
import type { ConfigManager } from "../../../config/manager.js";
import { getMemberLevel, resolvePluginConfig } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { runDreamcode } from "../../../dreamcode/index.js";
import { dreamCommandsDefaultOverrides } from "../defaultOverrides.js";
import { buildDreamGlobals } from "./context.js";
import { createDiscordActionHost } from "./host.js";
import { getDreamCommand } from "./store.js";

const rateBuckets = new Map<string, number>();
const RATE_MS = 1500;

function rateLimited(guildId: string, userId: string): boolean {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const last = rateBuckets.get(key) ?? 0;
  if (now - last < RATE_MS) return true;
  rateBuckets.set(key, now);
  return false;
}

export async function handleDreamCommandMessage(message: Message, configManager: ConfigManager): Promise<void> {
  if (!message.guild || !message.member || message.author.bot) return;
  if (!message.content || message.content.includes("\n")) return;

  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);
  if (!pluginEnabled(guildConfig, "dream_commands")) return;

  const pluginConfig = resolvePluginConfig(
    guildConfig,
    "dream_commands",
    dreamCommandsDefaultOverrides,
    message.member,
    message.channel.id,
    message.channel.isTextBased() && "parentId" in message.channel ? message.channel.parentId : null,
  );

  const prefix = typeof pluginConfig.prefix === "string" && pluginConfig.prefix.length > 0 ? pluginConfig.prefix : "d!";
  if (!message.content.startsWith(prefix)) return;

  const rest = message.content.slice(prefix.length).trimStart();
  if (!rest) return;

  const space = rest.search(/\s/);
  const rawName = space === -1 ? rest : rest.slice(0, space);
  const argText = space === -1 ? "" : rest.slice(space + 1).trim();
  if (!rawName) return;

  const command = await getDreamCommand(message.guild.id, rawName);
  if (!command || !command.enabled) return;

  const level = getMemberLevel(message.member, guildConfig.levels);
  if (level < command.minLevel) {
    await message.react("❌").catch(() => null);
    return;
  }

  if (rateLimited(message.guild.id, message.author.id)) {
    await message.react("⏳").catch(() => null);
    return;
  }

  const globals = buildDreamGlobals({
    message,
    member: message.member,
    guildConfig,
    argText,
  });

  const host = createDiscordActionHost({
    client: message.client,
    guild: message.guild,
    guildConfig,
    actor: message.member,
    trigger: message,
  });

  const result = await runDreamcode(command.source, { globals, host });

  if (!result.ok) {
    const text = result.aborted ? result.message : result.error.message;
    await message.reply({ content: `Dreamcode error: ${text.slice(0, 500)}` }).catch(() => null);
  }
}
