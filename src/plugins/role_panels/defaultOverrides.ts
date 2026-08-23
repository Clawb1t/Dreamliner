import type { ConfigOverride } from "../../core/types.js";

export const rolePanelsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_manage: true,
    },
  },
];

export const ROLE_PANEL_PREFIX = "dl:rolepanel:";

export function rolePanelButtonCustomId(panelId: string, roleId: string): string {
  return `${ROLE_PANEL_PREFIX}${panelId}:${roleId}`;
}

export function parseRolePanelButtonCustomId(customId: string): { panelId: string; roleId: string } | null {
  if (!customId.startsWith(ROLE_PANEL_PREFIX)) return null;
  const rest = customId.slice(ROLE_PANEL_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  return { panelId: rest.slice(0, sep), roleId: rest.slice(sep + 1) };
}
