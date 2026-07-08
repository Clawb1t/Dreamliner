const DISCORD_EPOCH = 1_420_070_400_000n;

export function snowflakeToTimestamp(id: string | bigint): Date {
  const snowflake = BigInt(id);
  const timestamp = Number((snowflake >> 22n) + DISCORD_EPOCH);
  return new Date(timestamp);
}

export function decodeSnowflake(id: string): {
  timestamp: Date;
  workerId: number;
  processId: number;
  increment: number;
} {
  const snowflake = BigInt(id);
  const timestamp = snowflakeToTimestamp(id);
  const workerId = Number((snowflake >> 17n) & 0x1fn);
  const processId = Number((snowflake >> 12n) & 0x1fn);
  const increment = Number(snowflake & 0xfffn);
  return { timestamp, workerId, processId, increment };
}

export function discordTimestamp(date: Date, style: "R" | "F" | "D" | "f" | "t" | "T" = "R"): string {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:${style}>`;
}

/** Full date with relative time, e.g. `<t:…:F> (<t:…:R>)` */
export function discordTimestampBoth(date: Date): string {
  return `${discordTimestamp(date, "F")} (${discordTimestamp(date, "R")})`;
}

export function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}
