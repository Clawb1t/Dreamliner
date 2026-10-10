import { Options, PermissionFlagsBits, type CacheFactory, type ClientOptions, type GuildMember, type SweeperOptions, type User } from "discord.js";

/**
 * discord.js cache limits. Left at the defaults, a long-running bot never forgets anything it has
 * seen: up to 200 messages per channel ever touched, every member ever fetched (several features
 * load whole member lists, and the cache keeps all of them), and every user behind them. With the
 * Message Content and Guild Members intents across many servers, that's what made memory climb
 * past a gigabyte over a day.
 *
 * Nothing in the bot reads the message cache (message logs keep their own store, and partials
 * cover reactions on old messages), so it stays small and short-lived. Members and users are swept
 * periodically and re-fetched on demand; a command that loads a full member list still sees the
 * whole list while it runs.
 */

const MINUTE = 60;

/** Elevated permissions: members with any of these are staff and stay cached (Impersonation
 *  protects staff by their cached roles; Tickets adds support staff from `role.members`). */
const STAFF_PERMISSIONS =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.ManageRoles;

/** True for members worth keeping between sweeps: the bot, the owner, staff, boosters, and anyone in voice. */
export function keepCachedMember(member: GuildMember): boolean {
  if (member.id === member.client.user?.id) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.voice?.channelId) return true;
  // Boosters: a small set Booster Roles re-checks every 15 minutes from the cache.
  if (member.premiumSinceTimestamp != null) return true;
  try {
    return member.permissions.any(STAFF_PERMISSIONS);
  } catch {
    // Permissions can't be computed (roles not loaded): treat as an ordinary member.
    return false;
  }
}

export const clientMakeCache: CacheFactory = Options.cacheWithLimits({
  ...Options.DefaultMakeCacheSettings,
  // Per channel. Enough for in-flight work (an edit or delete arriving right after a send).
  MessageManager: 25,
});

export const clientSweepers: SweeperOptions = {
  ...Options.DefaultSweeperSettings,
  messages: { interval: 5 * MINUTE, lifetime: 15 * MINUTE },
  guildMembers: {
    interval: 30 * MINUTE,
    filter: () => (member: GuildMember) => !keepCachedMember(member),
  },
  // Users not tied to a kept member are re-fetched when needed (interactions and messages carry them).
  users: {
    interval: 60 * MINUTE,
    filter: () => {
      // Built once per sweep: every user still behind a cached member stays.
      let kept: Set<string> | null = null;
      return (user: User) => {
        if (!kept) {
          kept = new Set([user.client.user?.id ?? ""]);
          for (const guild of user.client.guilds.cache.values()) {
            for (const id of guild.members.cache.keys()) kept.add(id);
          }
        }
        return !kept.has(user.id);
      };
    },
  },
};

export const clientCacheOptions: Pick<ClientOptions, "makeCache" | "sweepers"> = {
  makeCache: clientMakeCache,
  sweepers: clientSweepers,
};
