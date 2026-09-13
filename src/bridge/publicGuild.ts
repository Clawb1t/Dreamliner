import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";

function colorIntToHex(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value)))
    .toString(16)
    .padStart(6, "0")}`;
}

export async function buildPublicGuildHome(guild: Guild) {
  const [config, oneActive] = await Promise.all([
    configManager.getEffectiveConfig(guild.id),
    isDreamlinerOneActive(guild.id),
  ]);
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
  };
}
