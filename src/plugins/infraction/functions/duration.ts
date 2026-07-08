const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)([smhdw])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = UNITS[unit];
  if (!ms || amount <= 0) return null;
  return amount * ms;
}

export function formatDurationShort(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const parts: string[] = [];
  const weeks = Math.floor(seconds / 604_800);
  const days = Math.floor((seconds % 604_800) / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (weeks) parts.push(`${weeks}w`);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join("");
}

export function expiryFromDuration(durationMs: number, from = new Date()): Date {
  return new Date(from.getTime() + durationMs);
}
