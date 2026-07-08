import type { ConfigOverride } from "../../core/types.js";

export const roleButtonsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_create: true,
      can_delete: true,
    },
  },
];

export const ROLE_BUTTON_PREFIX = "dl:rolebtn:";

export function roleButtonCustomId(messageId: string, roleId: string): string {
  return `${ROLE_BUTTON_PREFIX}${messageId}:${roleId}`;
}

export function parseRoleButtonCustomId(customId: string): { messageId: string; roleId: string } | null {
  if (!customId.startsWith(ROLE_BUTTON_PREFIX)) return null;
  const rest = customId.slice(ROLE_BUTTON_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  return { messageId: rest.slice(0, sep), roleId: rest.slice(sep + 1) };
}
