import type { ConfigOverride } from "../../core/types.js";

export const companionChannelsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_delete: true,
    },
  },
];

export const HUB_OWNER_PREFIX = "hub:";

export function hubOwnerId(channelId: string): string {
  return `${HUB_OWNER_PREFIX}${channelId}`;
}

export function isHubOwnerId(ownerId: string): boolean {
  return ownerId.startsWith(HUB_OWNER_PREFIX);
}

export function hubChannelIdFromOwnerId(ownerId: string): string {
  return ownerId.slice(HUB_OWNER_PREFIX.length);
}
