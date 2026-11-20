/**
 * Ghost Mode for the website's User Settings and account menu. User-scoped: the website puts the
 * signed-in user's id (from its Auth.js session) in the path, /bridge/users/:id/ghost-mode.
 *
 *   GET    /ghost-mode                  state + allow list
 *   PUT    /ghost-mode                  { duration: "1h"|"8h"|"24h"|"3d"|"1w"|"forever"|"off", hideLeaderboards?: boolean }
 *   POST   /ghost-mode/allow            { viewerId }
 *   DELETE /ghost-mode/allow/:viewerId
 *   GET    /ghost-mode/people?q=        people the user shares a server with, for the allow list picker
 *
 * Ghost Mode only changes what other people see. Nothing stops being tracked.
 */
import type { Client } from "discord.js";
import {
  addToGhostAllowlist,
  getGhostState,
  GhostAllowlistError,
  listGhostAllowlist,
  removeFromGhostAllowlist,
  setGhostMode,
  setHideFromGlobalBoards,
} from "../core/privacy/ghostMode.js";
import { GHOST_ALLOWLIST_MAX, GHOST_DURATION_LABELS, isGhostActive, isGhostDuration } from "../core/privacy/policy.js";

export type GhostPerson = { id: string; name: string; username: string | null; avatar: string | null };

export type GhostModePayload = {
  on: boolean;
  /** ISO end time, null while on = until turned off. */
  until: string | null;
  hideLeaderboards: boolean;
  allowlist: GhostPerson[];
  allowlistMax: number;
  durations: Array<{ value: string; label: string }>;
};

function person(client: Client, id: string): GhostPerson {
  const user = client.users.cache.get(id);
  return {
    id,
    name: user?.globalName ?? user?.username ?? id,
    username: user?.username ?? null,
    avatar: user ? user.displayAvatarURL({ size: 64, extension: "png" }) : null,
  };
}

export async function getGhostModeForWeb(client: Client, userId: string): Promise<GhostModePayload> {
  const state = getGhostState(userId);
  const on = isGhostActive(state);
  const allow = listGhostAllowlist(userId);
  // Names for people the bot hasn't cached yet: one fetch each, bounded (the list is capped at 50).
  await Promise.all(allow.filter((row) => !client.users.cache.has(row.viewerId)).map((row) => client.users.fetch(row.viewerId).catch(() => null)));
  return {
    on,
    until: on && state.until ? state.until.toISOString() : null,
    hideLeaderboards: state.hideLeaderboards,
    allowlist: allow.map((row) => person(client, row.viewerId)),
    allowlistMax: GHOST_ALLOWLIST_MAX,
    durations: Object.entries(GHOST_DURATION_LABELS).map(([value, label]) => ({ value, label })),
  };
}

export type GhostUpdateResult = { ok: true } | { ok: false; status: number; error: string };

export function updateGhostModeForWeb(userId: string, body: { duration?: unknown; hideLeaderboards?: unknown }): GhostUpdateResult {
  if (body.duration === undefined && body.hideLeaderboards === undefined) return { ok: false, status: 400, error: "Nothing to change." };
  if (body.duration !== undefined && body.duration !== "off" && !isGhostDuration(body.duration)) {
    return { ok: false, status: 400, error: "duration must be 1h, 8h, 24h, 3d, 1w, forever or off." };
  }
  if (body.hideLeaderboards !== undefined && typeof body.hideLeaderboards !== "boolean") {
    return { ok: false, status: 400, error: "hideLeaderboards must be a boolean." };
  }
  if (body.duration !== undefined) setGhostMode(userId, body.duration === "off" ? null : (body.duration as Parameters<typeof setGhostMode>[1]));
  if (typeof body.hideLeaderboards === "boolean") setHideFromGlobalBoards(userId, body.hideLeaderboards);
  return { ok: true };
}

export function addGhostAllowForWeb(userId: string, viewerId: unknown): GhostUpdateResult {
  if (typeof viewerId !== "string") return { ok: false, status: 400, error: "viewerId is required." };
  try {
    addToGhostAllowlist(userId, viewerId);
    return { ok: true };
  } catch (error) {
    if (error instanceof GhostAllowlistError) return { ok: false, status: 400, error: error.message };
    throw error;
  }
}

export function removeGhostAllowForWeb(userId: string, viewerId: string): GhostUpdateResult {
  removeFromGhostAllowlist(userId, viewerId);
  return { ok: true };
}

/**
 * People the user shares at least one server with, matched by name, from the bot's member caches
 * only (no Discord requests). Only servers the user is actually in are searched, so this never
 * reveals anyone they couldn't already see in Discord.
 */
export function searchGhostPeople(client: Client, userId: string, query: string, limit = 10): GhostPerson[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const found = new Map<string, GhostPerson>();
  for (const guild of client.guilds.cache.values()) {
    if (!guild.members.cache.has(userId)) continue;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot || member.id === userId || found.has(member.id)) continue;
      const names = [member.user.username, member.user.globalName, member.nickname].filter((name): name is string => Boolean(name));
      if (!names.some((name) => name.toLowerCase().includes(q)) && member.id !== q) continue;
      found.set(member.id, {
        id: member.id,
        name: member.user.globalName ?? member.user.username,
        username: member.user.username,
        avatar: member.user.displayAvatarURL({ size: 64, extension: "png" }),
      });
      if (found.size >= limit) return [...found.values()];
    }
  }
  return [...found.values()];
}
