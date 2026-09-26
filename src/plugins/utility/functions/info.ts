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
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildVerificationLevel,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import { decodeSnowflake } from "../../../core/datetime.js";
import { getMemberPermissionRoles, hasAdminBypass } from "../../../core/permissionRoles.js";
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
  type ResultContainer,
} from "../../../core/embeds.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

const MAX_ROLES_TO_DISPLAY = 15;

function trimRoles(roles: Role[], t: Translator): string {
  const mentions = roles.map((r) => `<@&${r.id}>`);
  if (mentions.length > MAX_ROLES_TO_DISPLAY) {
    return t("utility.info.moreRolesSuffix", "{shown}, and {more} more roles", {
      shown: mentions.slice(0, MAX_ROLES_TO_DISPLAY).join(", "),
      more: mentions.length - MAX_ROLES_TO_DISPLAY,
    });
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
  t: Translator = defaultTranslator,
): Promise<ResultContainer> {
  const label = user.bot ? t("utility.info.botLabel", "Bot") : t("utility.info.userLabel", "User");
  const avatarURL = (member ?? user).displayAvatarURL({ size: 128 });

  const embed = setEmbedAuthor(
    baseEmbed(),
    label,
    client,
    commandHeader(guildConfig, { thumbnailURL: avatarURL, emoji: "<:icons_user_profile:1544418271355469885>" }),
  ).setColor(memberAccentColor(member));

  const [guildInfractions, globalInfractions, guildMessages, globalMessages] = await Promise.all([
    countUserInfractions(guildId, user.id),
    countUserInfractionsGlobal(user.id),
    getGuildMessageCount(guildId, user.id),
    getGlobalMessageCount(user.id),
  ]);

  const activityBody = t(
    "utility.info.activityBody",
    "Infractions (this server): **{guildInfractions}**\nInfractions (global): **{globalInfractions}**\nMessages (this server): **{guildMessages}**\nMessages (global): **{globalMessages}**",
    {
      guildInfractions,
      globalInfractions,
      guildMessages: guildMessages.toLocaleString(),
      globalMessages: globalMessages.toLocaleString(),
    },
  );

  if (compact) {
    let value = trimLines(
      t("utility.info.compactProfileBody", "Profile: <@!{id}>\nCreated: **{created}**", {
        id: user.id,
        created: discordTs(user.createdAt),
      }),
    );
    if (member?.joinedAt) {
      value += `\n${
        user.bot
          ? t("utility.info.addedLine", "Added: **{ts}**", { ts: discordTs(member.joinedAt) })
          : t("utility.info.joinedLine", "Joined: **{ts}**", { ts: discordTs(member.joinedAt) })
      }`;
    }
    embed.addFields(embedField(t("utility.info.labelInformation", "{label} information", { label }), value));
    embed.addFields(embedField(t("utility.info.activityLabel", "Activity"), trimLines(activityBody)));
    if (!member) {
      embed.addFields(
        embedField(t("utility.info.noteLabel", "!! NOTE !!"), t("utility.info.notOnServerBody", "{label} is not on the server", { label })),
      );
    }
    return embed;
  }

  const userLines = [
    t("utility.info.idLine", "ID: `{id}`", { id: user.id }),
    t("utility.info.usernameLine", "Username: **{username}**", { username: user.username }),
  ];
  if (user.globalName) userLines.push(t("utility.info.displayNameLine", "Display Name: **{name}**", { name: user.globalName }));
  userLines.push(t("utility.info.createdLine", "Created: **{ts}**", { ts: discordTs(user.createdAt) }));
  userLines.push(t("utility.info.mentionLine", "Mention: <@!{id}>", { id: user.id }));

  embed.addFields(embedField(t("utility.info.labelInformation", "{label} information", { label }), userLines.join("\n")));

  embed.addFields(embedField(t("utility.info.activityLabel", "Activity"), trimLines(activityBody)));

  if (member) {
    const roles = [...member.roles.cache.values()]
      .filter((r) => r.id !== member.guild.id)
      .sort((a, b) => b.position - a.position);
    const permissionRoles = await getMemberPermissionRoles(guildId, member);

    const memberInfoBody = t(
      "utility.info.memberInfoBody",
      "{joinedLabel}: **{joined}**\nDreamliner Roles: **{roles}**\n{roleList}",
      {
        joinedLabel: user.bot ? t("utility.info.addedWord", "Added") : t("utility.info.joinedWord", "Joined"),
        joined: member.joinedAt ? discordTs(member.joinedAt) : t("utility.info.unknownWord", "unknown"),
        roles: permissionRoles.map((r) => r.name).join(", ") || t("utility.info.noneWord", "none"),
        roleList: roles.length > 0 ? t("utility.info.rolesListLine", "Roles: {roles}", { roles: trimRoles(roles, t) }) : "",
      },
    );

    embed.addFields(embedField(t("utility.info.memberInformationLabel", "Member information"), trimLines(memberInfoBody)));

    const voiceChannel = member.voice.channel;
    if (voiceChannel || member.voice.serverMute || member.voice.serverDeaf || member.voice.selfMute || member.voice.selfDeaf) {
      const voiceLines = [
        voiceChannel ? t("utility.info.currentVoiceChannelLine", "Current voice channel: **{name}**", { name: voiceChannel.name }) : "",
        member.voice.serverMute ? t("utility.info.serverMutedLine", "Server-muted: **Yes**") : "",
        member.voice.serverDeaf ? t("utility.info.serverDeafenedLine", "Server-deafened: **Yes**") : "",
        member.voice.selfMute ? t("utility.info.selfMutedLine", "Self-muted: **Yes**") : "",
        member.voice.selfDeaf ? t("utility.info.selfDeafenedLine", "Self-deafened: **Yes**") : "",
      ].join("\n");
      embed.addFields(embedField(t("utility.info.voiceInformationLabel", "Voice information"), trimEmptyLines(voiceLines)));
    }
  } else {
    embed.addFields(
      embedField(t("utility.info.memberInformationLabel", "Member information"), t("utility.info.notOnServerWarnBody", "⚠ {label} is not on the server", { label })),
    );
  }

  return embed;
}

function verificationLabel(t: Translator, level: GuildVerificationLevel): string {
  const labels: Record<GuildVerificationLevel, string> = {
    [GuildVerificationLevel.None]: t("utility.info.verification.none", "None"),
    [GuildVerificationLevel.Low]: t("utility.info.verification.low", "Low"),
    [GuildVerificationLevel.Medium]: t("utility.info.verification.medium", "Medium"),
    [GuildVerificationLevel.High]: t("utility.info.verification.high", "High"),
    [GuildVerificationLevel.VeryHigh]: t("utility.info.verification.veryHigh", "Very High"),
  };
  return labels[level] ?? String(level);
}

function contentFilterLabel(t: Translator, level: GuildExplicitContentFilter): string {
  const labels: Record<GuildExplicitContentFilter, string> = {
    [GuildExplicitContentFilter.Disabled]: t("utility.info.contentFilter.disabled", "Disabled"),
    [GuildExplicitContentFilter.MembersWithoutRoles]: t("utility.info.contentFilter.membersWithoutRoles", "Members without roles"),
    [GuildExplicitContentFilter.AllMembers]: t("utility.info.contentFilter.allMembers", "All members"),
  };
  return labels[level] ?? String(level);
}

function nsfwLabel(t: Translator, level: GuildNSFWLevel): string {
  const labels: Record<GuildNSFWLevel, string> = {
    [GuildNSFWLevel.Default]: t("utility.info.nsfw.default", "Default"),
    [GuildNSFWLevel.Explicit]: t("utility.info.nsfw.explicit", "Explicit"),
    [GuildNSFWLevel.Safe]: t("utility.info.nsfw.safe", "Safe"),
    [GuildNSFWLevel.AgeRestricted]: t("utility.info.nsfw.ageRestricted", "Age restricted"),
  };
  return labels[level] ?? String(level);
}

function boostTierLabel(t: Translator, tier: GuildPremiumTier): string {
  const labels: Record<GuildPremiumTier, string> = {
    [GuildPremiumTier.None]: t("utility.info.boostTier.none", "None"),
    [GuildPremiumTier.Tier1]: t("utility.info.boostTier.level1", "Level 1"),
    [GuildPremiumTier.Tier2]: t("utility.info.boostTier.level2", "Level 2"),
    [GuildPremiumTier.Tier3]: t("utility.info.boostTier.level3", "Level 3"),
  };
  return labels[tier] ?? t("utility.info.boostTier.levelN", "Level {tier}", { tier });
}

function notableFeatureLabel(t: Translator, feature: string): string | undefined {
  const labels: Record<string, string> = {
    COMMUNITY: t("utility.info.feature.community", "Community"),
    VERIFIED: t("utility.info.feature.verified", "Verified"),
    PARTNERED: t("utility.info.feature.partnered", "Partnered"),
    DISCOVERABLE: t("utility.info.feature.discoverable", "Discoverable"),
    INVITES_DISABLED: t("utility.info.feature.invitesDisabled", "Invites disabled"),
    WELCOME_SCREEN_ENABLED: t("utility.info.feature.welcomeScreen", "Welcome screen"),
    MEMBER_VERIFICATION_GATE_ENABLED: t("utility.info.feature.membershipScreening", "Membership screening"),
    NEWS: t("utility.info.feature.announcementChannels", "Announcement channels"),
    ANIMATED_ICON: t("utility.info.feature.animatedIcon", "Animated icon"),
    ANIMATED_BANNER: t("utility.info.feature.animatedBanner", "Animated banner"),
    BANNER: t("utility.info.feature.banner", "Banner"),
    VANITY_URL: t("utility.info.feature.vanityUrl", "Vanity URL"),
    INVITE_SPLASH: t("utility.info.feature.inviteSplash", "Invite splash"),
    ROLE_ICONS: t("utility.info.feature.roleIcons", "Role icons"),
    ROLE_SUBSCRIPTIONS_ENABLED: t("utility.info.feature.roleSubscriptions", "Role subscriptions"),
    TICKETED_EVENTS_ENABLED: t("utility.info.feature.ticketedEvents", "Ticketed events"),
    MONETIZATION_ENABLED: t("utility.info.feature.monetization", "Monetization"),
    RAID_ALERTS_DISABLED: t("utility.info.feature.raidAlertsDisabled", "Raid alerts disabled"),
    PREVIEW_ENABLED: t("utility.info.feature.previewEnabled", "Preview enabled"),
  };
  return labels[feature];
}

function formatAfkTimeout(t: Translator, seconds: number): string {
  if (seconds <= 0) return t("utility.info.afkOff", "Off");
  if (seconds % 3600 === 0) return t("utility.info.afkHours", "{h}h", { h: seconds / 3600 });
  if (seconds % 60 === 0) return t("utility.info.afkMinutes", "{m}m", { m: seconds / 60 });
  return t("utility.info.afkSeconds", "{s}s", { s: seconds });
}

export async function buildServerInfoEmbed(
  guild: Guild,
  guildConfig: GuildConfig,
  client: Client,
  t: Translator = defaultTranslator,
): Promise<ResultContainer> {
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
    t("utility.info.serverNameTitle", "Server: {name}", { name: g.name }),
    client,
    commandHeader(guildConfig, { thumbnailURL: iconURL, emoji: "<:icons_globe:1544417296703815710>" }),
  );

  if (bannerURL) embed.setImage(bannerURL);

  const ownerLabel = owner
    ? t("utility.info.ownerKnown", "<@!{id}> (`{tag}`)", { id: owner.id, tag: owner.user.tag })
    : t("utility.info.ownerUnknown", "Unknown (`{id}`)", { id: g.ownerId });

  const basicLines = [
    t("utility.info.nameLine", "Name: **{name}**", { name: g.name }),
    g.nameAcronym ? t("utility.info.acronymLine", "Acronym: **{acronym}**", { acronym: g.nameAcronym }) : "",
    t("utility.info.idBacktickLine", "ID: `{id}`", { id: g.id }),
    t("utility.info.createdLine", "Created: **{ts}**", { ts: discordTs(g.createdAt) }),
    t("utility.info.ownerLine", "Owner: {owner}", { owner: ownerLabel }),
    g.description ? t("utility.info.descriptionLine", "Description: {desc}", { desc: `${g.description.slice(0, 200)}${g.description.length > 200 ? "…" : ""}` }) : "",
    g.vanityURLCode ? t("utility.info.vanityLine", "Vanity: **https://discord.gg/{code}**", { code: g.vanityURLCode }) : "",
    g.preferredLocale ? t("utility.info.localeLine", "Locale: **{locale}**", { locale: g.preferredLocale }) : "",
  ];

  embed.addFields(embedField(t("utility.info.serverInformationLabel", "Server information"), trimEmptyLines(basicLines.join("\n"))));

  const securityBody = t(
    "utility.info.securityBody",
    "Verification: **{verification}**\nContent filter: **{filter}**\nNSFW level: **{nsfw}**\n2FA moderation: **{mfa}**",
    {
      verification: verificationLabel(t, g.verificationLevel),
      filter: contentFilterLabel(t, g.explicitContentFilter),
      nsfw: nsfwLabel(t, g.nsfwLevel),
      mfa: g.mfaLevel === GuildMFALevel.Elevated ? t("utility.info.required", "Required") : t("utility.info.notRequired", "Not required"),
    },
  );

  const channelsMediaBody = t(
    "utility.info.channelsMediaBody",
    "System: {system}\nRules: {rules}\nAFK: {afk} ({afkTimeout})\nUpdates: {updates}",
    {
      system: g.systemChannel ? `<#${g.systemChannelId}>` : t("utility.info.noneBold", "**None**"),
      rules: g.rulesChannel ? `<#${g.rulesChannelId}>` : t("utility.info.noneBold", "**None**"),
      afk: g.afkChannel ? `<#${g.afkChannelId}>` : t("utility.info.noneBold", "**None**"),
      afkTimeout: formatAfkTimeout(t, g.afkTimeout),
      updates: g.publicUpdatesChannel ? `<#${g.publicUpdatesChannelId}>` : t("utility.info.noneBold", "**None**"),
    },
  );

  embed.addFields(
    embedField(t("utility.info.securityLabel", "Security"), trimLines(securityBody), true),
    embedField(t("utility.info.channelsMediaLabel", "Channels & media"), trimEmptyLines(channelsMediaBody), true),
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
  const boostTier = boostTierLabel(t, g.premiumTier);

  const membersBody = t(
    "utility.info.membersBody",
    "Total: **{total}**\nHumans: **{humans}**\nBots: **{bots}**{botsPartial}\n{online}",
    {
      total: totalMembers.toLocaleString(),
      humans: humans.toLocaleString(),
      bots: bots.toLocaleString(),
      botsPartial: g.members.cache.size < totalMembers ? "*" : "",
      online: online != null ? t("utility.info.onlineLine", "Online: **~{online}**", { online: online.toLocaleString() }) : "",
    },
  );

  const channelsBody = t(
    "utility.info.channelsBody",
    "Total: **{total}**\nText: **{text}**\nAnnouncement: **{announcement}**\nVoice: **{voice}**\nStage: **{stage}**\nForum/Media: **{forum}**\nCategories: **{categories}**\nThreads: **{threads}**",
    {
      total: channelTotal,
      text: textCount,
      announcement: announcementCount,
      voice: voiceCount,
      stage: stageCount,
      forum: forumCount,
      categories: categoryCount,
      threads: threadCount,
    },
  );

  const boostsAssetsBody = t(
    "utility.info.boostsAssetsBody",
    "Boosts: **{boosts}** ({tier})\nProgress bar: **{progressBar}**\nRoles: **{roles}**\nEmojis: **{emojis}** ({static} static / {animated} animated)\nStickers: **{stickers}**",
    {
      boosts: boostCount,
      tier: boostTier,
      progressBar: yesNo(g.premiumProgressBarEnabled, guildConfig.emojis),
      roles: g.roles.cache.size,
      emojis: g.emojis.cache.size,
      static: staticEmojis,
      animated: animatedEmojis,
      stickers,
    },
  );

  embed.addFields(
    embedField(t("utility.info.membersLabel", "Members"), trimEmptyLines(membersBody), true),
    embedField(t("utility.info.channelsLabel", "Channels"), trimLines(channelsBody), true),
    embedField(t("utility.info.boostsAssetsLabel", "Boosts & assets"), trimLines(boostsAssetsBody), true),
  );

  const notable = g.features
    .map((feature) => notableFeatureLabel(t, feature))
    .filter((label): label is string => Boolean(label));
  if (notable.length > 0) {
    embed.addFields(embedField(t("utility.info.featuresLabel", "Features"), notable.map((label) => `\`${label}\``).join(", ")));
  }

  const assetLinks = [
    iconURL ? t("utility.info.iconLink", "[Icon]({url})", { url: iconURL }) : null,
    bannerURL ? t("utility.info.bannerLink", "[Banner]({url})", { url: bannerURL }) : null,
    splashURL ? t("utility.info.inviteSplashLink", "[Invite splash]({url})", { url: splashURL }) : null,
    discoverySplashURL ? t("utility.info.discoverySplashLink", "[Discovery splash]({url})", { url: discoverySplashURL }) : null,
  ].filter(Boolean);

  if (assetLinks.length > 0) {
    embed.addFields(embedField(t("utility.info.assetsLabel", "Assets"), assetLinks.join(" · ")));
  }

  if (g.members.cache.size < totalMembers) {
    embed.setFooter({ text: t("utility.info.botCountFooter", "* Bot count is from cached members only") });
  }

  return embed;
}

function channelTypeLabel(t: Translator, type: ChannelType): string {
  const labels: Partial<Record<ChannelType, string>> = {
    [ChannelType.GuildText]: t("utility.info.channelType.text", "Text channel"),
    [ChannelType.GuildVoice]: t("utility.info.channelType.voice", "Voice channel"),
    [ChannelType.GuildCategory]: t("utility.info.channelType.category", "Category channel"),
    [ChannelType.GuildAnnouncement]: t("utility.info.channelType.announcement", "Announcement channel"),
    [ChannelType.GuildStageVoice]: t("utility.info.channelType.stage", "Stage channel"),
    [ChannelType.PublicThread]: t("utility.info.channelType.publicThread", "Public Thread channel"),
    [ChannelType.PrivateThread]: t("utility.info.channelType.privateThread", "Private Thread channel"),
    [ChannelType.GuildForum]: t("utility.info.channelType.forum", "Forum channel"),
    [ChannelType.GuildMedia]: t("utility.info.channelType.media", "Media channel"),
  };
  return labels[type] ?? t("utility.info.channelType.generic", "Channel");
}

export function buildChannelInfoEmbed(
  channel: Channel,
  guild: Guild,
  guildConfig: GuildConfig,
  client: Client,
  t: Translator = defaultTranslator,
): ResultContainer {
  const typeLabel = channelTypeLabel(t, channel.type);
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.channelTypeNameTitle", "{type}: {name}", { type: typeLabel, name: ("name" in channel ? channel.name : null) ?? t("utility.info.unknownWord", "unknown") }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_channel:1544417183734431805>" }),
  );

  let channelName = "name" in channel ? `#${channel.name}` : t("utility.info.unknownWord", "unknown");
  if (
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildCategory ||
    channel.type === ChannelType.GuildStageVoice
  ) {
    channelName = "name" in channel ? channel.name : t("utility.info.unknownWord", "unknown");
  }

  const showMention = channel.type !== ChannelType.GuildCategory;

  const channelInfoBody = t(
    "utility.info.channelInfoBody",
    "Name: **{name}**\nID: `{id}`\nCreated: **{created}**\nType: **{type}**\n{mention}",
    {
      name: channelName,
      id: channel.id,
      created: "createdTimestamp" in channel && channel.createdAt ? discordTs(channel.createdAt) : t("utility.info.unknownWord", "unknown"),
      type: typeLabel,
      mention: showMention ? t("utility.info.mentionChannelLine", "Mention: <#{id}>", { id: channel.id }) : "",
    },
  );

  embed.addFields(embedField(t("utility.info.channelInformationLabel", "Channel information"), trimLines(channelInfoBody)));

  if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    const vc = channel as VoiceChannel | StageChannel;
    const voiceMembers = [...vc.members.values()];
    const muted = voiceMembers.filter((m) => m.voice.mute || m.voice.selfMute);
    const deafened = voiceMembers.filter((m) => m.voice.deaf || m.voice.selfDeaf);
    const label = channel.type === ChannelType.GuildVoice ? t("utility.info.voiceWord", "Voice") : t("utility.info.stageWord", "Stage");

    embed.addFields(
      embedField(
        t("utility.info.labelInformation", "{label} information", { label }),
        trimLines(
          t(
            "utility.info.voiceUsersBody",
            "Users on {label} channel: **{count}**\nMuted: **{muted}**\nDeafened: **{deafened}**",
            { label: label.toLowerCase(), count: voiceMembers.length, muted: muted.length, deafened: deafened.length },
          ),
        ),
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
        t("utility.info.categoryInformationLabel", "Category information"),
        trimLines(
          t("utility.info.categoryChannelsBody", "Text channels: **{text}**\nVoice channels: **{voice}**", {
            text: textChannels.size,
            voice: voiceChannels.size,
          }),
        ),
      ),
    );
  }

  if ("topic" in channel && channel.topic) {
    embed.addFields(embedField(t("utility.info.topicLabel", "Topic"), channel.topic));
  }

  return embed;
}

export function buildMessageInfoEmbed(
  message: Message,
  guildId: string,
  guildConfig: GuildConfig,
  client: Client,
  t: Translator = defaultTranslator,
): ResultContainer {
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.messageIdTitle", "Message: {id}", { id: message.id }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_message:1544417564447350804>" }),
  );

  const messageInfoBody = t(
    "utility.info.messageInfoBody",
    "ID: `{id}`\nChannel: <#{channelId}>\nCreated: **{created}**\n{edited}\nLink: [**Go to message ➔**]({link})",
    {
      id: message.id,
      channelId: message.channelId,
      created: discordTs(message.createdAt),
      edited: message.editedAt ? t("utility.info.editedLine", "Edited: **{ts}**", { ts: discordTs(message.editedAt) }) : "",
      link: `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`,
    },
  );

  const authorInfoBody = t(
    "utility.info.authorInfoBody",
    "Name: **{tag}**\nID: `{id}`\nCreated: **{created}**\n{joined}\nMention: <@!{id}>",
    {
      tag: message.author.tag,
      id: message.author.id,
      created: discordTs(message.author.createdAt),
      joined: message.member?.joinedAt ? t("utility.info.joinedLine", "Joined: **{ts}**", { ts: discordTs(message.member.joinedAt) }) : "",
    },
  );

  embed.addFields(
    embedField(t("utility.info.messageInformationLabel", "Message information"), trimLines(messageInfoBody)),
    embedField(t("utility.info.authorInformationLabel", "Author information"), trimLines(authorInfoBody)),
  );

  const content = message.content || " ";
  embed.addFields(embedField(t("utility.info.textContentLabel", "Text content"), content.slice(0, 1024)));

  if (message.attachments.size > 0) {
    embed.addFields(embedField(t("utility.info.attachmentsLabel", "Attachments"), [...message.attachments.values()].map((a) => a.url).join("\n")));
  }

  return embed;
}

export function buildInviteInfoEmbed(invite: Invite, guildConfig: GuildConfig, client: Client, t: Translator = defaultTranslator): ResultContainer {
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.inviteCodeTitle", "Invite: {code}", { code: invite.code }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_invite:1544417309345710080>" }),
  );

  const inviteInfoBody = t(
    "utility.info.inviteInfoBody",
    "Code: `{code}`\nServer: **{server}** (`{serverId}`)\nChannel: **{channel}**\nUses: **{uses}** / **{maxUses}**\nExpires: **{expires}**\nInviter: **{inviter}**",
    {
      code: invite.code,
      server: invite.guild?.name ?? t("utility.info.unknownWord", "unknown"),
      serverId: invite.guild?.id ?? "?",
      channel: invite.channel?.name ?? t("utility.info.unknownWord", "unknown"),
      uses: invite.uses ?? "?",
      maxUses: invite.maxUses ?? "∞",
      expires: invite.expiresAt ? discordTs(invite.expiresAt) : t("utility.info.neverWord", "never"),
      inviter: invite.inviter?.tag ?? t("utility.info.unknownWord", "unknown"),
    },
  );

  embed.addFields(embedField(t("utility.info.inviteInformationLabel", "Invite information"), trimLines(inviteInfoBody)));

  return embed;
}

/**
 * `role.members` only sees members already in the cache, so load the full member list before
 * counting. Like search.ts, only fetch when the cache is short, and let a failed fetch (opcode-8
 * rate limit, chunk timeout) fall back to the cache rather than fail the command.
 */
export async function ensureMembersCached(guild: Guild): Promise<void> {
  if (guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch().catch(() => null);
  }
}

export function buildRoleInfoEmbed(role: Role, guild: Guild, guildConfig: GuildConfig, client: Client, t: Translator = defaultTranslator): ResultContainer {
  const totalRoles = guild.roles.cache.size - 1;
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.roleNameTitle", "Role: {name}", { name: role.name }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_roles:1544417804994871338>" }),
  );

  const perms = role.permissions.has(PermissionFlagsBits.Administrator)
    ? [t("utility.info.administratorWord", "Administrator")]
    : role.permissions.toArray().slice(0, 8).map((p) => String(p));

  const roleInfoBody = t(
    "utility.info.roleInfoBody",
    "Name: **{name}**\nID: `{id}`\nCreated: **{created}**\nPosition: **{position} / {total}**\nColor: **{color}**\nMembers: **{members}**\nMentionable: **{mentionable}**\nHoisted: **{hoisted}**\nPermissions: `{perms}`\nMention: <@&{id}>",
    {
      name: role.name,
      id: role.id,
      created: discordTs(role.createdAt),
      position: role.position,
      total: totalRoles,
      color: role.hexColor,
      members: role.members.size,
      mentionable: yesNo(role.mentionable, guildConfig.emojis),
      hoisted: yesNo(role.hoist, guildConfig.emojis),
      perms: perms.length ? perms.join(", ") : t("utility.info.noneWord", "none"),
    },
  );

  embed.addFields(embedField(t("utility.info.roleInformationLabel", "Role information"), trimLines(roleInfoBody)));

  return embed;
}

export function buildEmojiInfoEmbed(emoji: GuildEmoji, guildConfig: GuildConfig, client: Client, t: Translator = defaultTranslator): ResultContainer {
  return setEmbedAuthor(
    baseEmbed(),
    t("utility.info.emojiNameTitle", "Emoji: {name}", { name: emoji.name }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_updateemoji:1544417817099767897>" }),
  ).addFields(
    embedField(
      t("utility.info.emojiInformationLabel", "Emoji information"),
      trimLines(
        t("utility.info.emojiInfoBody", "Name: **{name}**\nID: `{id}`\nAnimated: **{animated}**\nCreated: **{created}**", {
          name: emoji.name,
          id: emoji.id,
          animated: yesNo(emoji.animated, guildConfig.emojis),
          created: discordTs(emoji.createdAt),
        }),
      ),
    ),
  );
}

export function buildSnowflakeInfoEmbed(
  id: string,
  guildConfig: GuildConfig,
  client: Client,
  unknown = false,
  t: Translator = defaultTranslator,
): ResultContainer {
  const decoded = decodeSnowflake(id);
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.snowflakeIdTitle", "Snowflake: {id}", { id }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_snowflake:1544418147967434752>" }),
  );

  if (unknown) {
    embed.setDescription(t("utility.info.unknownSnowflakeBody", "This is a valid snowflake ID, but I don't know what it's for."));
  }

  embed.addFields(
    embedField(
      t("utility.info.basicInformationLabel", "Basic information"),
      trimLines(
        t(
          "utility.info.snowflakeInfoBody",
          "Created: **{created}**\nWorker ID: **{workerId}**\nProcess ID: **{processId}**\nIncrement: **{increment}**",
          {
            created: discordTs(decoded.timestamp),
            workerId: decoded.workerId,
            processId: decoded.processId,
            increment: decoded.increment,
          },
        ),
      ),
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
  t: Translator = defaultTranslator,
): ResultContainer {
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
    lines.push(t("utility.info.andMoreRoles", "... and {count} more", { count: sorted.length - 50 }));
  }

  return setEmbedAuthor(
    baseEmbed(),
    t("utility.info.rolesTotalTitle", "Roles: {count} total", { count: sorted.length }),
    client,
    commandHeader(guildConfig, { emoji: "<:icons_list:1544417562325164173>" }),
  ).setDescription(codeBlock(lines.join("\n")));
}

export async function buildLevelEmbed(guildId: string, member: GuildMember, guildConfig: GuildConfig, client: Client, t: Translator = defaultTranslator): Promise<ResultContainer> {
  const roles = await getMemberPermissionRoles(guildId, member);
  const bypass = hasAdminBypass(member, guildConfig);
  const embed = setEmbedAuthor(
    baseEmbed(),
    t("utility.info.userTagTitle", "User: {tag}", { tag: member.user.tag }),
    client,
    commandHeader(guildConfig, {
      thumbnailURL: member.displayAvatarURL({ size: 128 }),
      emoji: "<:icons_trophy:1544418249721126922>",
    }),
  ).setColor(memberAccentColor(member));
  embed.addFields(
    embedField(
      t("utility.info.dreamlinerRolesLabel", "Dreamliner Roles"),
      trimLines(
        t(
          "utility.info.dreamlinerRolesBody",
          "Member: <@!{id}>\nRoles: **{roles}**\n{bypass}",
          {
            id: member.id,
            roles: roles.map((r) => r.name).join(", ") || t("utility.info.noneWord", "none"),
            bypass: bypass ? t("utility.info.adminBypassBody", "Admin bypass: **on** (full access regardless of role assignment)") : "",
          },
        ),
      ),
    ),
  );
  return embed;
}

export async function resolveInfoTarget(
  input: string,
  guild: Guild,
  guildConfig: GuildConfig,
  client: Client,
  t: Translator = defaultTranslator,
): Promise<{ type: string; embed: ResultContainer } | null> {
  const trimmed = input.trim();

  if (/^\d{17,20}$/.test(trimmed)) {
    const channel = guild.channels.cache.get(trimmed);
    if (channel) return { type: "channel", embed: buildChannelInfoEmbed(channel, guild, guildConfig, client, t) };

    const role = guild.roles.cache.get(trimmed);
    if (role) {
      await ensureMembersCached(guild);
      return { type: "role", embed: buildRoleInfoEmbed(role, guild, guildConfig, client, t) };
    }

    const emoji = guild.emojis.cache.get(trimmed);
    if (emoji) return { type: "emoji", embed: buildEmojiInfoEmbed(emoji, guildConfig, client, t) };

    try {
      const member = await guild.members.fetch(trimmed);
      return { type: "user", embed: await buildUserInfoEmbed(member.user, member, guildConfig, guild.id, client, false, t) };
    } catch {
      return { type: "snowflake", embed: buildSnowflakeInfoEmbed(trimmed, guildConfig, client, true, t) };
    }
  }

  if (trimmed.startsWith("<#") && trimmed.endsWith(">")) {
    const id = trimmed.slice(2, -1);
    const channel = guild.channels.cache.get(id);
    if (channel) return { type: "channel", embed: buildChannelInfoEmbed(channel, guild, guildConfig, client, t) };
  }

  if (trimmed.startsWith("<@") && trimmed.endsWith(">")) {
    const id = trimmed.replace(/[<@!>]/g, "");
    try {
      const member = await guild.members.fetch(id);
      return { type: "user", embed: await buildUserInfoEmbed(member.user, member, guildConfig, guild.id, client, false, t) };
    } catch {
      return null;
    }
  }

  const inviteMatch = trimmed.match(/(?:discord\.gg\/|discord\.com\/invite\/)([a-zA-Z0-9-]+)/);
  if (inviteMatch) {
    try {
      const invite = await guild.client.fetchInvite(inviteMatch[1]);
      return { type: "invite", embed: buildInviteInfoEmbed(invite, guildConfig, client, t) };
    } catch {
      return null;
    }
  }

  return null;
}
