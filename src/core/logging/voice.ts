const forcedVoiceActions = new Map<string, number>();

export function markForcedVoiceAction(guildId: string, userId: string): void {
  forcedVoiceActions.set(`${guildId}:${userId}`, Date.now());
}

export function isForcedVoiceAction(guildId: string, userId: string): boolean {
  const key = `${guildId}:${userId}`;
  const at = forcedVoiceActions.get(key);
  if (!at) return false;
  if (Date.now() - at > 3000) {
    forcedVoiceActions.delete(key);
    return false;
  }
  forcedVoiceActions.delete(key);
  return true;
}
