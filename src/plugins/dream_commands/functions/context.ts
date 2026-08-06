import type { GuildMember, Message, TextChannel } from "discord.js";
import type { DreamObject, DreamValue } from "../../../dreamcode/index.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getModerationLogChannelId, getServerLogChannelId } from "../../../core/logging/channels.js";
import { channelObject, guildObject, memberObject, messageObject, roleObject, userObject } from "./objects.js";

/**
 * Build Dreamcode globals from a triggering message and remaining arg text.
 * `argText` is everything after `prefix + commandName` (trimmed leading space).
 */
export function buildDreamGlobals(input: {
  message: Message;
  member: GuildMember;
  guildConfig: GuildConfig;
  argText: string;
  /** Named values from typed `@slash arg` options (slash invocations). */
  namedArgs?: Record<string, DreamValue>;
}): Record<string, DreamValue> {
  const { message, member, guildConfig, argText, namedArgs } = input;
  const guild = message.guild!;

  const tokens = tokenizeArgs(argText);
  const mentionUserIds = [...message.mentions.users.keys()];
  const mentionRoleIds = [...message.mentions.roles.keys()];
  const mentionChannelIds = [...message.mentions.channels.keys()];

  let userId = mentionUserIds[0] ?? null;
  if (!userId) {
    for (const tok of tokens) {
      const m = tok.match(/^<@!?(\d+)>$/) || (/^\d{17,20}$/.test(tok) ? [tok, tok] : null);
      if (m) {
        userId = m[1]!;
        break;
      }
    }
  }

  let roleId = mentionRoleIds[0] ?? null;
  if (!roleId) {
    for (const tok of tokens) {
      const m = tok.match(/^<@&(\d+)>$/);
      if (m) {
        roleId = m[1]!;
        break;
      }
    }
  }

  let channelId = mentionChannelIds[0] ?? null;
  if (!channelId) {
    for (const tok of tokens) {
      const m = tok.match(/^<#(\d+)>$/);
      if (m) {
        channelId = m[1]!;
        break;
      }
    }
  }

  const arg: DreamObject = {
    __type: "args",
    rest: argText,
    count: tokens.length,
  };

  for (let i = 0; i < tokens.length && i < 20; i++) {
    arg[String(i + 1)] = tokens[i]!;
  }

  if (userId) {
    const mentioned = message.mentions.users.get(userId);
    const mentionedMember = message.mentions.members?.get(userId) ?? null;
    if (mentionedMember) {
      arg.user = memberObject(mentionedMember, guildConfig);
    } else if (mentioned) {
      arg.user = userObject(mentioned, 0);
    } else {
      arg.user = { __type: "user", id: userId, name: userId, mention: `<@${userId}>`, level: 0 };
    }
  } else {
    arg.user = null;
  }

  if (roleId) {
    const role = guild.roles.cache.get(roleId);
    arg.role = role ? roleObject(role) : { __type: "role", id: roleId, name: roleId, mention: `<@&${roleId}>` };
  } else {
    arg.role = null;
  }

  if (channelId) {
    const ch = guild.channels.cache.get(channelId);
    arg.channel = ch ? channelObject(ch) : { __type: "channel", id: channelId, name: channelId, mention: `<#${channelId}>` };
  } else {
    arg.channel = null;
  }

  if (namedArgs) {
    for (const [key, value] of Object.entries(namedArgs)) {
      arg[key] = value;
    }
    if (arg.user == null) {
      for (const value of Object.values(namedArgs)) {
        if (isDreamEntity(value, "member") || isDreamEntity(value, "user")) {
          arg.user = value;
          break;
        }
      }
    }
    if (arg.role == null) {
      for (const value of Object.values(namedArgs)) {
        if (isDreamEntity(value, "role")) {
          arg.role = value;
          break;
        }
      }
    }
    if (arg.channel == null) {
      for (const value of Object.values(namedArgs)) {
        if (isDreamEntity(value, "channel")) {
          arg.channel = value;
          break;
        }
      }
    }
  }

  const channel =
    message.channel.isTextBased() && "name" in message.channel
      ? channelObject(message.channel as TextChannel)
      : channelObject({ id: message.channel.id, name: message.channel.id });

  const invoker = memberObject(member, guildConfig);

  return {
    invoker,
    user: invoker,
    guild: guildObject(guild),
    channel,
    trigger: messageObject(message),
    arg,
    bot: {
      __type: "bot",
      id: message.client.user?.id ?? "",
      name: message.client.user?.username ?? "Dreamliner",
      mention: message.client.user ? `<@${message.client.user.id}>` : "",
    },
    logs: {
      __type: "logs",
      moderationChannelId: getModerationLogChannelId(guildConfig) ?? null,
      serverChannelId: getServerLogChannelId(guildConfig) ?? null,
    },
    result: null,
  };
}

function tokenizeArgs(text: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[1] ?? m[2] ?? "");
  }
  return tokens;
}

function isDreamEntity(value: DreamValue, type: string): value is DreamObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.__type === type);
}
