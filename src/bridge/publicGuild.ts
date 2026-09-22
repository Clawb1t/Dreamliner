import { ChannelType, GuildFeature, GuildVerificationLevel, type Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { getDreamlinerOnePublicStatusWithRefresh } from "./dreamlinerOne.js";
import { getTopChannelsByDaily } from "../plugins/stats/functions/queries.js";
import { buildWebPublicMessagerLeaderboard } from "./webStats.js";

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

const MAX_VOICE_CHANNELS = 6;
const MAX_VOICE_MEMBERS_PER_CHANNEL = 12;
const MAX_ACTIVE_CHANNELS = 6;

/** Voice channels with someone in them right now, most populated first. Excludes the AFK
 *  channel — anyone parked there isn't meaningfully "active". Reads straight from the cached
 *  voice state (populated on connect, kept live by voice state updates), no extra API calls. */
function buildVoiceActivity(guild: Guild) {
  const channels: { channelId: string; channelName: string; memberCount: number; members: { id: string; name: string; avatar: string }[] }[] = [];

  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased() || channel.id === guild.afkChannelId) continue;
    const members = [...channel.members.values()];
    if (members.length === 0) continue;
    channels.push({
      channelId: channel.id,
      channelName: channel.name,
      memberCount: members.length,
      members: members.slice(0, MAX_VOICE_MEMBERS_PER_CHANNEL).map((member) => ({
        id: member.id,
        name: member.displayName,
        avatar: member.displayAvatarURL({ size: 64 }),
      })),
    });
  }

  return channels.sort((a, b) => b.memberCount - a.memberCount).slice(0, MAX_VOICE_CHANNELS);
}

/** Text channels with the most tracked messages today (UTC), busiest first — a lightweight
 *  stand-in for "what's active right now" using the same daily counters the Stats plugin
 *  already keeps, rather than anything live/per-message. */
async function buildActiveChannels(guild: Guild) {
  const rows = await getTopChannelsByDaily(guild.id, 1, MAX_ACTIVE_CHANNELS);
  return rows
    .map((row) => {
      const channel = guild.channels.cache.get(row.channelId);
      if (!channel || !("name" in channel) || row.count <= 0) return null;
      return { channelId: row.channelId, channelName: channel.name, messageCount: row.count };
    })
    .filter((entry): entry is { channelId: string; channelName: string; messageCount: number } => entry !== null);
}

function buildBoostStatus(guild: Guild) {
  return {
    tier: guild.premiumTier as number,
    count: guild.premiumSubscriptionCount ?? 0,
  };
}

/** Top 5 all-time messagers, reusing the exact same builder (and so the exact same row shape —
 *  avatar, badges, accent color, banner) as the full public leaderboard page, instead of a
 *  second, slightly-different implementation just for this preview. */
async function buildLeaderboardPreview(guild: Guild) {
  const { leaders } = await buildWebPublicMessagerLeaderboard(guild, 5);
  return leaders;
}

const MAX_EMOJIS = 60;

/** This server's custom emojis, newest-cached-order (roughly upload order), capped so a
 *  heavily-boosted server with hundreds of emoji slots doesn't blow the payload up — the
 *  gallery shows a "+N more" beyond the cap instead. */
function buildEmojis(guild: Guild) {
  const all = [...guild.emojis.cache.values()];
  const emojis = all.slice(0, MAX_EMOJIS).map((emoji) => ({
    id: emoji.id,
    name: emoji.name ?? "emoji",
    url: emoji.imageURL({ size: 128, extension: emoji.animated ? "gif" : "png" }) ?? emoji.url,
    animated: Boolean(emoji.animated),
  }));
  return { emojis, totalCount: all.length };
}

/** Approximate online-vs-offline split, straight from Discord's own `with_counts` guild fetch
 *  (the same data behind Discord's server invite preview) — no Presence privileged intent
 *  needed. Best-effort: a rate limit or fetch hiccup just omits this from the page. */
async function fetchPresenceCounts(guild: Guild): Promise<{ online: number | null }> {
  try {
    const fetched = await guild.client.guilds.fetch({ guild: guild.id, withCounts: true, force: true });
    return { online: fetched.approximatePresenceCount ?? null };
  } catch {
    return { online: null };
  }
}

const VERIFICATION_LEVEL_LABEL: Record<GuildVerificationLevel, string> = {
  [GuildVerificationLevel.None]: "None",
  [GuildVerificationLevel.Low]: "Low",
  [GuildVerificationLevel.Medium]: "Medium",
  [GuildVerificationLevel.High]: "High",
  [GuildVerificationLevel.VeryHigh]: "Very high",
};

/** A subset of Discord's own `guild.features` worth showing off publicly, in the order they
 *  should read — everything else (dozens of internal/rollout flags) is not shown. */
const FEATURE_BADGES: { flag: GuildFeature; label: string }[] = [
  { flag: GuildFeature.Partnered, label: "Partnered" },
  { flag: GuildFeature.Verified, label: "Verified" },
  { flag: GuildFeature.Discoverable, label: "Discoverable" },
  { flag: GuildFeature.Community, label: "Community" },
];

/** Structural facts about the server that are already visible to anyone via Discord's own
 *  invite preview or widget — channel/role/emoji counts, verification level, feature badges,
 *  the vanity URL if one is set, and an approximate online/offline split. No opt-in toggle,
 *  same as the member count/created date/owner already shown unconditionally. */
async function buildServerInfo(guild: Guild) {
  const channels = { text: 0, voice: 0, category: 0, forum: 0 };
  for (const channel of guild.channels.cache.values()) {
    switch (channel.type) {
      case ChannelType.GuildText:
      case ChannelType.GuildAnnouncement:
        channels.text++;
        break;
      case ChannelType.GuildVoice:
      case ChannelType.GuildStageVoice:
        channels.voice++;
        break;
      case ChannelType.GuildCategory:
        channels.category++;
        break;
      case ChannelType.GuildForum:
      case ChannelType.GuildMedia:
        channels.forum++;
        break;
      default:
        break;
    }
  }

  const { online } = await fetchPresenceCounts(guild);

  return {
    channels,
    roleCount: Math.max(0, guild.roles.cache.size - 1),
    emojiCount: guild.emojis.cache.size,
    stickerCount: guild.stickers.cache.size,
    verificationLevel: VERIFICATION_LEVEL_LABEL[guild.verificationLevel],
    badges: FEATURE_BADGES.filter((b) => guild.features.includes(b.flag)).map((b) => b.label),
    vanityUrl: guild.vanityURLCode ? `discord.gg/${guild.vanityURLCode}` : null,
    onlineCount: online,
    offlineCount: online == null ? null : Math.max(0, guild.memberCount - online),
  };
}

export async function buildPublicGuildHome(guild: Guild) {
  const [config, oneStatus] = await Promise.all([
    configManager.getEffectiveConfig(guild.id),
    getDreamlinerOnePublicStatusWithRefresh(guild.id),
  ]);
  const oneActive = oneStatus.active;
  let ownerName: string | null = null;
  let ownerDisplayName: string | null = null;
  let ownerAvatar: string | null = null;
  try {
    const owner =
      guild.members.cache.get(guild.ownerId) ??
      (await guild.fetchOwner({ cache: true }).catch(() => null));
    if (owner) {
      ownerName = owner.user.username;
      ownerDisplayName = owner.displayName;
      ownerAvatar = owner.user.displayAvatarURL({ size: 64 });
    }
  } catch {
    // Owner may be unavailable.
  }

  const serverPage = config.server_page;
  const [voiceActivity, activeChannels, serverInfo, leaderboardPreview] = await Promise.all([
    serverPage.show_voice_activity ? buildVoiceActivity(guild) : Promise.resolve(undefined),
    serverPage.show_active_channels ? buildActiveChannels(guild) : Promise.resolve(undefined),
    buildServerInfo(guild),
    serverPage.show_leaderboard ? buildLeaderboardPreview(guild) : Promise.resolve(undefined),
  ]);
  const emojis = serverPage.show_emojis ? buildEmojis(guild) : undefined;

  return {
    ok: true as const,
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      banner: guild.banner,
      memberCount: guild.memberCount,
      createdAt: guild.createdAt.toISOString(),
      ownerId: guild.ownerId,
      ownerName,
      ownerDisplayName,
      ownerAvatar,
    },
    theme: {
      accentColor: colorIntToHex(config.server_accent_color),
      overrideUserAccents: Boolean(config.leaderboard_override_user_accents),
    },
    leaderboardAlwaysPublic: true as const,
    oneActive,
    oneActiveSince: oneStatus.since,
    serverInfo,
    serverPage: {
      description: serverPage.description,
      showDescription: serverPage.show_description,
      inviteUrl: serverPage.invite_url || null,
      customLinks: serverPage.custom_links.map((link) => ({ label: link.label, url: link.url })),
      widgets: {
        voiceActivity: serverPage.show_voice_activity,
        activeChannels: serverPage.show_active_channels,
        boostStatus: serverPage.show_boost_status,
        emojis: serverPage.show_emojis,
        leaderboard: serverPage.show_leaderboard,
      },
      voiceActivity,
      activeChannels,
      boostStatus: serverPage.show_boost_status ? buildBoostStatus(guild) : undefined,
      emojis,
      leaderboardPreview,
    },
  };
}
