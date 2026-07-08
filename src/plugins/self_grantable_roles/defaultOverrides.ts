import type { ConfigOverride } from "../../core/types.js";

export const selfGrantableRolesDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_configure: true,
    },
  },
];

export const SELF_ROLE_PREFIX = "dl:selfrole:";

export type SelfRolePanelConfig = {
  roleIds: string[];
  style: "buttons" | "select";
};

export function selfRoleButtonCustomId(messageId: string, roleId: string): string {
  return `${SELF_ROLE_PREFIX}${messageId}:${roleId}`;
}

export function selfRoleSelectCustomId(messageId: string): string {
  return `${SELF_ROLE_PREFIX}${messageId}`;
}

export function parseSelfRoleButtonCustomId(customId: string): { messageId: string; roleId: string } | null {
  if (!customId.startsWith(SELF_ROLE_PREFIX)) return null;
  const rest = customId.slice(SELF_ROLE_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  return { messageId: rest.slice(0, sep), roleId: rest.slice(sep + 1) };
}

export function parseSelfRoleSelectCustomId(customId: string): { messageId: string } | null {
  if (!customId.startsWith(SELF_ROLE_PREFIX)) return null;
  const messageId = customId.slice(SELF_ROLE_PREFIX.length);
  if (!messageId || messageId.includes(":")) return null;
  return { messageId };
}
