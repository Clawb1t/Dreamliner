import type {
  Channel,
  Guild,
  GuildMember,
  Invite,
  Message,
  Role,
  GuildEmoji,
  User,
  VoiceChannel,
  StageChannel,
} from "discord.js";
import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Client } from "discord.js";
import { decodeSnowflake } from "../../../core/datetime.js";
import { getMemberLevel } from "../../../core/permissions.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { countUserInfractions, countUserInfractionsGlobal } from "../../infraction/functions/infractions.js";
import { getGlobalMessageCount, getGuildMessageCount } from "./messageCounts.js";
import {
  baseEmbed,
  codeBlock,
  commandHeader,
  discordTs,
  embedField,
  memberAccentColor,
  PRE_EMBED_PADDING,
  setEmbedAuthor,
  trimEmptyLines,
  trimLines,
  yesNo,
} from "../../../core/embeds.js";

const MAX_ROLES_TO_DISPLAY = 15;

function trimRoles(roles: Role[]): string {
  const mentions = roles.map((r) => `<@&${r.id}>`);
  if (mentions.length > MAX_ROLES_TO_DISPLAY) {
    return `${mentions.slice(0, MAX_ROLES_TO_DISPLAY).join(", ")}, and ${mentions.length - MAX_ROLES_TO_DISPLAY} more roles`;
  }
  return mentions.join(", ");
}

export async function buildUserInfoEmbed(
  user: User,
  member: GuildMember | null,
  guildConfig: GuildConfig,
  guildId: string,
  client: Client,
  compact = false,
): Promise<EmbedBuilder> {
  const label = user.bot ? "Bot" : "User";
  const avatarURL = (member ?? user).displayAvatarURL({ size: 128 });

  const embed = setEmbedAuthor(
    baseEmbed(),
    label,
    client,
    commandHeader(guildConfig, { thumbnailURL: avatarURL }),
  );

  const accent = memberAccentColor(member);
  if (accent) embed.setColor(accent);

  const [guildInfractions, globalInfractions, guildMessages, globalMessages] = await Promise.all([
    countUserInfractions(guildId, user.id),
    countUserInfractionsGlobal(user.id),
    getGuildMessageCount(guildId, user.id),
    getGlobalMessageCount(user.id),
  ]);

  if (compact) {
    let value = trimLines(`
      Profile: <@!${user.id}>
      Created: **${discordTs(user.createdAt)}**
    `);
    if (member?.joinedAt) {
      value += `\n${user.bot ? "Added" : "Joined"}: **${discordTs(member.joinedAt)}**`;
    }
    embed.addFields(embedField(`${label} information`, value));
    embed.addFields(
      embedField(
        "Activity",
        trimLines(`
          Infractions (this server): **${guildInfractions}**
          Infractions (global): **${globalInfractions}**
          Messages (this server): **${guildMessages.toLocaleString()}**
          Messages (global): **${globalMessages.toLocaleString()}**
        `),
      ),
    );
    if (!member) {
      embed.addFields(embedField("!! NOTE !!", `${label} is not on the server`));
    }
    return embed;
  }

  const userLines = [
    `ID: \`${user.id}\``,
    `Username: **${user.username}**`,
  ];
  if (user.globalName) userLines.push(`Display Name: **${user.globalName}**`);
  userLines.push(`Created: **${discordTs(user.createdAt)}**`);
  userLines.push(`Mention: <@!${user.id}>`);

  embed.addFields(embedField(`${label} information`, userLines.join("\n")));

  embed.addFields(
    embedField(
      "Activity",
      trimLines(`
        Infractions (this server): **${guildInfractions}**
        Infractions (global): **${globalInfractions}**
        Messages (this server): **${guildMessages.toLocaleString()}**
        Messages (global): **${globalMessages.toLocaleString()}**
      `),
    ),
  );

  if (member) {
    const roles = [...member.roles.cache.values()]
      .filter((r) => r.id !== member.guild.id)
      .sort((a, b) => b.position - a.position);

    embed.addFields(
      embedField(
        "Member information",
        trimLines(`
          ${user.bot ? "Added" : "Joined"}: **${member.joinedAt ? discordTs(member.joinedAt) : "unknown"}**
          Level: **${getMemberLevel(member, guildConfig.levels)}**
          ${roles.length > 0 ? `Roles: ${trimRoles(roles)}` : ""}
        `),
      ),
    );

    const voiceChannel = member.voice.channel;
    if (voiceChannel || member.voice.serverMute || member.voice.serverDeaf || member.voice.selfMute || member.voice.selfDeaf) {
      embed.addFields(
        embedField(
          "Voice information",
          trimEmptyLines(`
            ${voiceChannel ? `Current voice channel: **${voiceChannel.name}**` : ""}
            ${member.voice.serverMute ? "Server-muted: **Yes**" : ""}
            ${member.voice.serverDeaf ? "Server-deafened: **Yes**" : ""}
            ${member.voice.selfMute ? "Self-muted: **Yes**" : ""}
            ${member.voice.selfDeaf ? "Self-deafened: **Yes**" : ""}
          `),
        ),
      );
    }
  } else {
    embed.addFields(embedField("Member information", `⚠ ${label} is not on the server`));
  }

  return embed;
}

export function buildServerInfoEmbed(guild: Guild, guildConfig: GuildConfig, client: Client): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Server: ${guild.name}`, client, commandHeader(guildConfig));

  const owner = guild.members.cache.get(guild.ownerId);
  const basic = [
    `Created: **${discordTs(guild.createdAt)}**`,
    `Owner: **${owner?.user.tag ?? "Unknown"}** (\`${guild.ownerId}\`)`,
  ];
  if (guild.features.length > 0) {
    basic.push(`Features: ${guild.features.map((f) => `\`${f}\``).join(", ")}`);
  }

  embed.setDescription(`${PRE_EMBED_PADDING}**Basic Information**\n${basic.join("\n")}`);

  const totalMembers = guild.memberCount ?? guild.members.cache.size;
  const online = guild.members.cache.filter((m) => m.presence?.status && m.presence.status !== "offline").size;

  embed.addFields(
    embedField(
      "Members",
      trimLines(`
        Total: **${totalMembers}**
        Online: **${online}**
        Offline: **${Math.max(0, totalMembers - online)}**
      `),
      true,
    ),
    embedField(
      "Channels",
      trimLines(`
        Total: **${guild.channels.cache.filter((c) => !c.isThread()).size}**
        Text: **${guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size}**
        Voice: **${guild.channels.cache.filter((c) => c.isVoiceBased()).size}**
      `),
      true,
    ),
    embedField(
      "Other stats",
      trimLines(`
        Roles: **${guild.roles.cache.size}**
        Emojis: **${guild.emojis.cache.size}**
        Boosts: **${guild.premiumSubscriptionCount ?? 0}**${guild.premiumTier ? ` (level ${guild.premiumTier})` : ""}
      `),
      true,
    ),
  );

  return embed;
}

function channelTypeLabel(type: ChannelType): string {
  const labels: Partial<Record<ChannelType, string>> = {
    [ChannelType.GuildText]: "Text channel",
    [ChannelType.GuildVoice]: "Voice channel",
    [ChannelType.GuildCategory]: "Category channel",
    [ChannelType.GuildAnnouncement]: "Announcement channel",
    [ChannelType.GuildStageVoice]: "Stage channel",
    [ChannelType.PublicThread]: "Public Thread channel",
    [ChannelType.PrivateThread]: "Private Thread channel",
    [ChannelType.GuildForum]: "Forum channel",
    [ChannelType.GuildMedia]: "Media channel",
  };
  return labels[type] ?? "Channel";
}

export function buildChannelInfoEmbed(
  channel: Channel,
  guild: Guild,
  guildConfig: GuildConfig,
  client: Client,
): EmbedBuilder {
  const typeLabel = channelTypeLabel(channel.type);
  const embed = setEmbedAuthor(
    baseEmbed(),
    `${typeLabel}: ${"name" in channel ? channel.name : "unknown"}`,
    client,
    commandHeader(guildConfig),
  );

  let channelName = "name" in channel ? `#${channel.name}` : "unknown";
  if (
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildCategory ||
    channel.type === ChannelType.GuildStageVoice
  ) {
    channelName = "name" in channel ? channel.name : "unknown";
  }

  const showMention = channel.type !== ChannelType.GuildCategory;

  embed.addFields(
    embedField(
      "Channel information",
      trimLines(`
        Name: **${channelName}**
        ID: \`${channel.id}\`
        Created: **${"createdTimestamp" in channel && channel.createdAt ? discordTs(channel.createdAt) : "unknown"}**
        Type: **${typeLabel}**
        ${showMention ? `Mention: <#${channel.id}>` : ""}
      `),
    ),
  );

  if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    const vc = channel as VoiceChannel | StageChannel;
    const voiceMembers = [...vc.members.values()];
    const muted = voiceMembers.filter((m) => m.voice.mute || m.voice.selfMute);
    const deafened = voiceMembers.filter((m) => m.voice.deaf || m.voice.selfDeaf);
    const label = channel.type === ChannelType.GuildVoice ? "Voice" : "Stage";

    embed.addFields(
      embedField(
        `${label} information`,
        trimLines(`
          Users on ${label.toLowerCase()} channel: **${voiceMembers.length}**
          Muted: **${muted.length}**
          Deafened: **${deafened.length}**
        `),
      ),
    );
  }

  if (channel.type === ChannelType.GuildCategory) {
    const textChannels = guild.channels.cache.filter((ch) => ch.parentId === channel.id && !ch.isVoiceBased());
    const voiceChannels = guild.channels.cache.filter(
      (ch) => ch.parentId === channel.id && ch.isVoiceBased(),
    );
    embed.addFields(
      embedField(
        "Category information",
        trimLines(`
          Text channels: **${textChannels.size}**
          Voice channels: **${voiceChannels.size}**
        `),
      ),
    );
  }

  if ("topic" in channel && channel.topic) {
    embed.addFields(embedField("Topic", channel.topic));
  }

  return embed;
}

export function buildMessageInfoEmbed(
  message: Message,
  guildId: string,
  guildConfig: GuildConfig,
  client: Client,
): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Message: ${message.id}`, client, commandHeader(guildConfig));

  embed.addFields(
    embedField(
      "Message information",
      trimLines(`
        ID: \`${message.id}\`
        Channel: <#${message.channelId}>
        Created: **${discordTs(message.createdAt)}**
        ${message.editedAt ? `Edited: **${discordTs(message.editedAt)}**` : ""}
        Link: [**Go to message ➔**](https://discord.com/channels/${guildId}/${message.channelId}/${message.id})
      `),
    ),
    embedField(
      "Author information",
      trimLines(`
        Name: **${message.author.tag}**
        ID: \`${message.author.id}\`
        Created: **${discordTs(message.author.createdAt)}**
        ${message.member?.joinedAt ? `Joined: **${discordTs(message.member.joinedAt)}**` : ""}
        Mention: <@!${message.author.id}>
      `),
    ),
  );

  const content = message.content || " ";
  embed.addFields(embedField("Text content", content.slice(0, 1024)));

  if (message.attachments.size > 0) {
    embed.addFields(embedField("Attachments", [...message.attachments.values()].map((a) => a.url).join("\n")));
  }

  return embed;
}

export function buildInviteInfoEmbed(invite: Invite, guildConfig: GuildConfig, client: Client): EmbedBuilder {
  const embed = setEmbedAuthor(baseEmbed(), `Invite: ${invite.code}`, client, commandHeader(guildConfig));

  embed.addFields(
    embedField(
      "Invite information",
      trimLines(`
        Code: \`${invite.code}\`
        Server: **${invite.guild?.name ?? "unknown"}** (\`${invite.guild?.id ?? "?"}\`)
        Channel: **${invite.channel?.name ?? "unknown"}**
        Uses: **${invite.uses ?? "?"}** / **${invite.maxUses ?? "∞"}**
        Expires: **${invite.expiresAt ? discordTs(invite.expiresAt) : "never"}**
        Inviter: **${invite.inviter?.tag ?? "unknown"}**
      `),
    ),
  );

  return embed;
}

export function buildRoleInfoEmbed(role: Role, guild: Guild, guildConfig: GuildConfig, client: Client): EmbedBuilder {
  const totalRoles = guild.roles.cache.size - 1;
  const embed = setEmbedAuthor(
    baseEmbed().setColor(role.color || 0x5865f2),
    `Role: ${role.name}`,
    client,
    commandHeader(guildConfig),
  );

  const perms = role.permissions.has(PermissionFlagsBits.Administrator)
    ? ["Administrator"]
    : role.permissions.toArray().slice(0, 8).map((p) => String(p));

  embed.addFields(
    embedField(
      "Role information",
      trimLines(`
        Name: **${role.name}**
        ID: \`${role.id}\`
        Created: **${discordTs(role.createdAt)}**
        Position: **${role.position} / ${totalRoles}**
        Color: **${role.hexColor}**
        Members: **${role.members.size}**
        Mentionable: **${yesNo(role.mentionable, guildConfig.emojis)}**
        Hoisted: **${yesNo(role.hoist, guildConfig.emojis)}**
        Permissions: \`${perms.length ? perms.join(", ") : "None"}\`
        Mention: <@&${role.id}>
      `),
    ),
  );

  return embed;
}

export function buildEmojiInfoEmbed(emoji: GuildEmoji, guildConfig: GuildConfig, client: Client): EmbedBuilder {
  return setEmbedAuthor(baseEmbed(), `Emoji: ${emoji.name}`, client, commandHeader(guildConfig))
    .addFields(
      embedField(
        "Emoji information",
        trimLines(`
          Name: **${emoji.name}**
          ID: \`${emoji.id}\`
          Animated: **${yesNo(emoji.animated, guildConfig.emojis)}**
          Created: **${discordTs(emoji.createdAt)}**
        `),
      ),
    );
}

export function buildSnowflakeInfoEmbed(
  id: string,
  guildConfig: GuildConfig,
  client: Client,
  unknown = false,
): EmbedBuilder {
  const decoded = decodeSnowflake(id);
  const embed = setEmbedAuthor(baseEmbed(), `Snowflake: ${id}`, client, commandHeader(guildConfig));

  if (unknown) {
    embed.setDescription(
      "This is a valid snowflake ID, but I don't know what it's for.",
    );
  }

  embed.addFields(
    embedField(
      "Basic information",
      trimLines(`
        Created: **${discordTs(decoded.timestamp)}**
        Worker ID: **${decoded.workerId}**
        Process ID: **${decoded.processId}**
        Increment: **${decoded.increment}**
      `),
    ),
  );

  return embed;
}

export function buildRolesListEmbed(
  roles: Role[],
  withCounts: boolean,
  sort: string,
  guildConfig: GuildConfig,
  client: Client,
): EmbedBuilder {
  let sorted = [...roles].filter((r) => r.id !== r.guild.id);

  if (sort === "position" || sort === "order") {
    sorted.sort((a, b) => b.position - a.position);
  } else if (sort === "memberCount") {
    sorted.sort((a, b) => b.members.size - a.members.size);
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines = sorted.slice(0, 50).map((role) => {
    const count = withCounts ? ` (${role.members.size})` : "";
    return `${role.name}${count}`;
  });

  if (sorted.length > 50) {
    lines.push(`... and ${sorted.length - 50} more`);
  }

  return setEmbedAuthor(baseEmbed(), `Roles: ${sorted.length} total`, client, commandHeader(guildConfig))
    .setDescription(codeBlock(lines.join("\n")));
}

export function buildLevelEmbed(member: GuildMember, guildConfig: GuildConfig, client: Client): EmbedBuilder {
  const level = getMemberLevel(member, guildConfig.levels);
  const embed = setEmbedAuthor(
    baseEmbed(),
    `User: ${member.user.tag}`,
    client,
    commandHeader(guildConfig, { thumbnailURL: member.displayAvatarURL({ size: 128 }) }),
  );
  const accent = memberAccentColor(member);
  if (accent) embed.setColor(accent);
  embed.addFields(
    embedField(
      "Permission level",
      trimLines(`
        Member: <@!${member.id}>
        Level: **${level}**
      `),
    ),
  );
  return embed;
}

export async function resolveInfoTarget(
  input: string,
  guild: Guild,
  guildConfig: GuildConfig,
  client: Client,
): Promise<{ type: string; embed: EmbedBuilder } | null> {
  const trimmed = input.trim();

  if (/^\d{17,20}$/.test(trimmed)) {
    const channel = guild.channels.cache.get(trimmed);
    if (channel) return { type: "channel", embed: buildChannelInfoEmbed(channel, guild, guildConfig, client) };

    const role = guild.roles.cache.get(trimmed);
    if (role) return { type: "role", embed: buildRoleInfoEmbed(role, guild, guildConfig, client) };

    const emoji = guild.emojis.cache.get(trimmed);
    if (emoji) return { type: "emoji", embed: buildEmojiInfoEmbed(emoji, guildConfig, client) };

    try {
      const member = await guild.members.fetch(trimmed);
      return { type: "user", embed: await buildUserInfoEmbed(member.user, member, guildConfig, guild.id, client) };
    } catch {
      return { type: "snowflake", embed: buildSnowflakeInfoEmbed(trimmed, guildConfig, client, true) };
    }
  }

  if (trimmed.startsWith("<#") && trimmed.endsWith(">")) {
    const id = trimmed.slice(2, -1);
    const channel = guild.channels.cache.get(id);
    if (channel) return { type: "channel", embed: buildChannelInfoEmbed(channel, guild, guildConfig, client) };
  }

  if (trimmed.startsWith("<@") && trimmed.endsWith(">")) {
    const id = trimmed.replace(/[<@!>]/g, "");
    try {
      const member = await guild.members.fetch(id);
      return { type: "user", embed: await buildUserInfoEmbed(member.user, member, guildConfig, guild.id, client) };
    } catch {
      return null;
    }
  }

  const inviteMatch = trimmed.match(/(?:discord\.gg\/|discord\.com\/invite\/)([a-zA-Z0-9-]+)/);
  if (inviteMatch) {
    try {
      const invite = await guild.client.fetchInvite(inviteMatch[1]);
      return { type: "invite", embed: buildInviteInfoEmbed(invite, guildConfig, client) };
    } catch {
      return null;
    }
  }

  return null;
}
