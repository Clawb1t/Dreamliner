import type { Guild } from "discord.js";
import type { AutoroleConfig, NormalizedAutoroleEntry } from "../../../config/schemas/autorole.js";
import { formatDurationShort, parseDuration } from "../../infraction/functions/duration.js";
import { normalizeAutoroleEntries } from "./applyRoles.js";

export type StoredAutoroleEntry = {
  roleId: string;
  delayMs: number;
  delay?: string;
};

export function getStoredAutoroleEntries(config: AutoroleConfig): StoredAutoroleEntry[] {
  return normalizeAutoroleEntries(config).map((entry) => {
    const raw = config.roles.find((item) => (typeof item === "string" ? item : item.role) === entry.roleId);
    const delay = typeof raw === "object" ? raw.delay : undefined;
    return { roleId: entry.roleId, delayMs: entry.delayMs, ...(delay ? { delay } : {}) };
  });
}

export function serializeAutoroleRoles(entries: StoredAutoroleEntry[]): AutoroleConfig["roles"] {
  return entries.map((entry) => {
    if (entry.delay) {
      return { role: entry.roleId, delay: entry.delay, delay_ms: 0 };
    }
    return { role: entry.roleId, delay_ms: entry.delayMs };
  });
}

export function parseDelayInput(
  input: string,
): { ok: true; delayMs: number; delay?: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "0") {
    return { ok: true, delayMs: 0 };
  }

  const parsed = parseDuration(trimmed);
  if (parsed === null) {
    return {
      ok: false,
      message: "Use a duration like `30s`, `5m`, `1h`, `1d`, or `1w`, or `0` for immediate assignment.",
    };
  }

  return { ok: true, delayMs: parsed, delay: trimmed.toLowerCase() };
}

export function formatAutoroleDelay(entry: Pick<NormalizedAutoroleEntry, "delayMs"> & { delay?: string }): string {
  if (entry.delayMs === 0 && !entry.delay) return "Immediate";
  if (entry.delay) return entry.delay;
  return formatDurationShort(entry.delayMs);
}

export function formatAutoroleEntry(roleId: string, entry: Pick<NormalizedAutoroleEntry, "delayMs"> & { delay?: string }): string {
  return `<@&${roleId}> · ${formatAutoroleDelay(entry)}`;
}

export function validateAutoroleTarget(guild: Guild, roleId: string): string | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) return "Role not found.";
  if (role.managed) return "Managed roles cannot be used as autoroles.";
  const bot = guild.members.me;
  if (!bot?.permissions.has("ManageRoles")) return "Bot lacks **Manage Roles** permission.";
  if (role.position >= bot.roles.highest.position) return "That role is above the bot's highest role.";
  return null;
}
