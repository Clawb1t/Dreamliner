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
import {
  ChannelType,
  EmbedBuilder,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildVerificationLevel,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
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

const VERIFICATION_LABELS: Record<GuildVerificationLevel, string> = {
  [GuildVerificationLevel.None]: "None",
  [GuildVerificationLevel.Low]: "Low",
  [GuildVerificationLevel.Medium]: "Medium",
  [GuildVerificationLevel.High]: "High",
  [GuildVerificationLevel.VeryHigh]: "Very High",
};

const CONTENT_FILTER_LABELS: Record<GuildExplicitContentFilter, string> = {
  [GuildExplicitContentFilter.Disabled]: "Disabled",
  [GuildExplicitContentFilter.MembersWithoutRoles]: "Members without roles",
  [GuildExplicitContentFilter.AllMembers]: "All members",
};

const NSFW_LABELS: Record<GuildNSFWLevel, string> = {
  [GuildNSFWLevel.Default]: "Default",
  [GuildNSFWLevel.Explicit]: "Explicit",
  [GuildNSFWLevel.Safe]: "Safe",
  [GuildNSFWLevel.AgeRestricted]: "Age restricted",
};

const BOOST_TIER_LABELS: Record<GuildPremiumTier, string> = {
  [GuildPremiumTier.None]: "None",
  [GuildPremiumTier.Tier1]: "Level 1",
  [GuildPremiumTier.Tier2]: "Level 2",
  [GuildPremiumTier.Tier3]: "Level 3",
};

const NOTABLE_FEATURES: Record<string, string> = {
  COMMUNITY: "Community",
  VERIFIED: "Verified",
  PARTNERED: "Partnered",
  DISCOVERABLE: "Discoverable",
  INVITES_DISABLED: "Invites disabled",
  WELCOME_SCREEN_ENABLED: "Welcome screen",
  MEMBER_VERIFICATION_GATE_ENABLED: "Membership screening",
  NEWS: "Announcement channels",
  ANIMATED_ICON: "Animated icon",
  ANIMATED_BANNER: "Animated banner",
  BANNER: "Banner",
  VANITY_URL: "Vanity URL",
  INVITE_SPLASH: "Invite splash",
  ROLE_ICONS: "Role icons",
  ROLE_SUBSCRIPTIONS_ENABLED: "Role subscriptions",
  TICKETED_EVENTS_ENABLED: "Ticketed events",
  MONETIZATION_ENABLED: "Monetization",
  RAID_ALERTS_DISABLED: "Raid alerts disabled",
  PREVIEW_ENABLED: "Preview enabled",
};

function formatAfkTimeout(seconds: number): string {
  if (seconds <= 0) return "Off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export async function buildServerInfoEmbed(guild: Guild, guildConfig: GuildConfig, client: Client): Promise<EmbedBuilder> {
  const [owner, refreshed] = await Promise.all([
    guild.members.fetch(guild.ownerId).catch(() => guild.members.cache.get(guild.ownerId) ?? null),
    guild.fetch().catch(() => guild),
  ]);
  const g = refreshed;

  const iconURL = g.iconURL({ size: 256 });
  const bannerURL = g.bannerURL({ size: 1024 });
  const splashURL = g.splashURL({ size: 512 });
  const discoverySplashURL = g.discoverySplashURL({ size: 512 });

  const embed = setEmbedAuthor(
    baseEmbed(),
    `Server: ${g.name}`,
    client,
    commandHeader(guildConfig, { thumbnailURL: iconURL }),
  );

  if (bannerURL) embed.setImage(bannerURL);

  const ownerLabel = owner
    ? `<@!${owner.id}> (\`${owner.user.tag}\`)`
    : `Unknown (\`${g.ownerId}\`)`;

  const basicLines = [
    `Name: **${g.name}**`,
    g.nameAcronym ? `Acronym: **${g.nameAcronym}**` : "",
    `ID: \`${g.id}\``,
    `Created: **${discordTs(g.createdAt)}**`,
    `Owner: ${ownerLabel}`,
    g.description ? `Description: ${g.description.slice(0, 200)}${g.description.length > 200 ? "…" : ""}` : "",
    g.vanityURLCode ? `Vanity: **https://discord.gg/${g.vanityURLCode}**` : "",
    g.preferredLocale ? `Locale: **${g.preferredLocale}**` : "",
  ];

  embed.addFields(embedField("Server information", trimEmptyLines(basicLines.join("\n"))));

  embed.addFields(
    embedField(
      "Security",
      trimLines(`
        Verification: **${VERIFICATION_LABELS[g.verificationLevel] ?? g.verificationLevel}**
        Content filter: **${CONTENT_FILTER_LABELS[g.explicitContentFilter] ?? g.explicitContentFilter}**
        NSFW level: **${NSFW_LABELS[g.nsfwLevel] ?? g.nsfwLevel}**
        2FA moderation: **${g.mfaLevel === GuildMFALevel.Elevated ? "Required" : "Not required"}**
      `),
      true,
    ),
    embedField(
      "Channels & media",
      trimEmptyLines(`
        System: ${g.systemChannel ? `<#${g.systemChannelId}>` : "**None**"}
        Rules: ${g.rulesChannel ? `<#${g.rulesChannelId}>` : "**None**"}
        AFK: ${g.afkChannel ? `<#${g.afkChannelId}>` : "**None**"} (${formatAfkTimeout(g.afkTimeout)})
        Updates: ${g.publicUpdatesChannel ? `<#${g.publicUpdatesChannelId}>` : "**None**"}
      `),
      true,
    ),
  );

  const totalMembers = g.memberCount || g.approximateMemberCount || g.members.cache.size;
  const bots = g.members.cache.filter((m) => m.user.bot).size;
  const cachedHumans = g.members.cache.filter((m) => !m.user.bot).size;
  const online = g.approximatePresenceCount;
  const humans =
    g.members.cache.size >= totalMembers
      ? cachedHumans
      : Math.max(0, totalMembers - bots);

  const channels = g.channels.cache;
  const textCount = channels.filter((c) => c.type === ChannelType.GuildText).size;
  const announcementCount = channels.filter((c) => c.type === ChannelType.GuildAnnouncement).size;
  const voiceCount = channels.filter((c) => c.type === ChannelType.GuildVoice).size;
  const stageCount = channels.filter((c) => c.type === ChannelType.GuildStageVoice).size;
  const forumCount = channels.filter((c) => c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia).size;
  const categoryCount = channels.filter((c) => c.type === ChannelType.GuildCategory).size;
  const threadCount = channels.filter((c) => c.isThread()).size;
  const channelTotal = channels.filter((c) => !c.isThread()).size;

  const staticEmojis = g.emojis.cache.filter((e) => !e.animated).size;
  const animatedEmojis = g.emojis.cache.filter((e) => e.animated).size;
  const stickers = g.stickers.cache.size;
  const boostCount = g.premiumSubscriptionCount ?? 0;
  const boostTier = BOOST_TIER_LABELS[g.premiumTier] ?? `Level ${g.premiumTier}`;

  embed.addFields(
    embedField(
      "Members",
      trimEmptyLines(`
        Total: **${totalMembers.toLocaleString()}**
        Humans: **${humans.toLocaleString()}**
        Bots: **${bots.toLocaleString()}**${g.members.cache.size < totalMembers ? "*" : ""}
        ${online != null ? `Online: **~${online.toLocaleString()}**` : ""}
      `),
      true,
    ),
    embedField(
      "Channels",
      trimLines(`
        Total: **${channelTotal}**
        Text: **${textCount}**
        Announcement: **${announcementCount}**
        Voice: **${voiceCount}**
        Stage: **${stageCount}**
        Forum/Media: **${forumCount}**
        Categories: **${categoryCount}**
        Threads: **${threadCount}**
      `),
      true,
    ),
    embedField(
      "Boosts & assets",
      trimLines(`
        Boosts: **${boostCount}** (${boostTier})
        Progress bar: **${yesNo(g.premiumProgressBarEnabled, guildConfig.emojis)}**
        Roles: **${g.roles.cache.size}**
        Emojis: **${g.emojis.cache.size}** (${staticEmojis} static / ${animatedEmojis} animated)
        Stickers: **${stickers}**
      `),
      true,
    ),
  );

  const notable = g.features
    .map((feature) => NOTABLE_FEATURES[feature])
    .filter((label): label is string => Boolean(label));
  if (notable.length > 0) {
    embed.addFields(embedField("Features", notable.map((label) => `\`${label}\``).join(", ")));
  }

  const assetLinks = [
    iconURL ? `[Icon](${iconURL})` : null,
    bannerURL ? `[Banner](${bannerURL})` : null,
    splashURL ? `[Invite splash](${splashURL})` : null,
    discoverySplashURL ? `[Discovery splash](${discoverySplashURL})` : null,
  ].filter(Boolean);

  if (assetLinks.length > 0) {
    embed.addFields(embedField("Assets", assetLinks.join(" · ")));
  }

  if (g.members.cache.size < totalMembers) {
    embed.setFooter({ text: "* Bot count is from cached members only" });
  }

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
