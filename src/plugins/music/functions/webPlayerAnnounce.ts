/** Guilds that have already gotten the "manage this queue online" container for their current
 *  playback session - reset on playerDestroy so a fresh session (new join, 24/7 reconnect)
 *  announces again. Shared between commands (which mark it themselves, since they already send a
 *  message that can carry the second container) and events.ts (which falls back to sending it on
 *  its own for sessions with no command reply to attach to, e.g. boot resume). */
const announced = new Set<string>();

export function hasAnnouncedWebPlayer(guildId: string): boolean {
  return announced.has(guildId);
}

export function markWebPlayerAnnounced(guildId: string): void {
  announced.add(guildId);
}

export function clearWebPlayerAnnounced(guildId: string): void {
  announced.delete(guildId);
}
