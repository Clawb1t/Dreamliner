import type {
  ChatInputCommandInteraction,
  GuildMember,
  Role,
  User,
} from "discord.js";
import type { DreamObject, DreamValue, SlashArgDef } from "../../../dreamcode/index.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { channelObject, memberObject, roleObject, userObject } from "./objects.js";

/** Resolve typed `@slash arg` options into Dreamcode `arg.<name>` values. */
export async function resolveSlashArgValues(
  interaction: ChatInputCommandInteraction,
  defs: SlashArgDef[],
  guildConfig: GuildConfig,
): Promise<Record<string, DreamValue>> {
  const out: Record<string, DreamValue> = {};
  if (!defs.length) return out;

  for (const def of defs) {
    switch (def.type) {
      case "string":
        out[def.name] = interaction.options.getString(def.name);
        break;
      case "integer":
        out[def.name] = interaction.options.getInteger(def.name);
        break;
      case "number":
        out[def.name] = interaction.options.getNumber(def.name);
        break;
      case "boolean":
        out[def.name] = interaction.options.getBoolean(def.name);
        break;
      case "user": {
        const member = interaction.options.getMember(def.name);
        const user = interaction.options.getUser(def.name);
        if (member && typeof member !== "string" && "guild" in member) {
          out[def.name] = memberObject(member as GuildMember, guildConfig);
        } else if (user) {
          out[def.name] = userObject(user, 0);
        } else {
          out[def.name] = null;
        }
        break;
      }
      case "role": {
        const role = interaction.options.getRole(def.name);
        out[def.name] = role && "position" in role ? roleObject(role as Role) : null;
        break;
      }
      case "channel": {
        const channel = interaction.options.getChannel(def.name);
        if (channel && "id" in channel) {
          const full = interaction.guild?.channels.cache.get(channel.id) ?? channel;
          out[def.name] = channelObject(full as Parameters<typeof channelObject>[0]);
        } else {
          out[def.name] = null;
        }
        break;
      }
      case "mentionable": {
        const mentionable = interaction.options.getMentionable(def.name);
        if (!mentionable) {
          out[def.name] = null;
        } else if ("members" in mentionable && "position" in mentionable) {
          out[def.name] = roleObject(mentionable as Role);
        } else if ("username" in mentionable) {
          const user = mentionable as User;
          const member = interaction.guild
            ? await interaction.guild.members.fetch(user.id).catch(() => null)
            : null;
          out[def.name] = member ? memberObject(member, guildConfig) : userObject(user, 0);
        } else {
          out[def.name] = null;
        }
        break;
      }
      case "attachment": {
        const att = interaction.options.getAttachment(def.name);
        out[def.name] = att ? attachmentObject(att) : null;
        break;
      }
      default:
        out[def.name] = null;
    }
  }

  return out;
}

function attachmentObject(att: {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}): DreamObject {
  return {
    __type: "attachment",
    id: att.id,
    name: att.name,
    url: att.url,
    contentType: att.contentType,
    size: att.size,
  };
}
