import type { DreamValue } from "../../../dreamcode/index.js";

/** Extract a Discord snowflake from a Dreamcode value. */
export function valueToId(value: DreamValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const mention = value.match(/^<@!?(\d+)>$/) || value.match(/^<#(\d+)>$/) || value.match(/^<@&(\d+)>$/);
    if (mention) return mention[1]!;
    if (/^\d{17,20}$/.test(value.trim())) return value.trim();
    return null;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && !Array.isArray(value) && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

export function valueToString(value: DreamValue | undefined, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.mention === "string") return value.mention;
    if (typeof value.name === "string") return value.name;
    if (typeof value.id === "string") return value.id;
  }
  return fallback;
}

export function valueToInt(value: DreamValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}
