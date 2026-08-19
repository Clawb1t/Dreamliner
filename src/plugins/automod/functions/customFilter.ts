import type { AutomodFilterEntry } from "../../../config/schemas/automod.js";
import { compileUserRegex } from "../../../core/userRegex.js";

const regexCache = new Map<string, RegExp | null>();

function getRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  const re = compileUserRegex(pattern);
  regexCache.set(pattern, re);
  return re;
}

export function matchCustomFilter(
  content: string,
  entries: AutomodFilterEntry[],
): AutomodFilterEntry | null {
  const lower = content.toLowerCase();
  for (const entry of entries) {
    if (!entry.enabled || !entry.pattern.trim()) continue;
    if (entry.regex) {
      const re = getRegex(entry.pattern);
      if (re?.test(content)) return entry;
      continue;
    }
    if (lower.includes(entry.pattern.toLowerCase())) return entry;
  }
  return null;
}

export function parseFilterEntries(settings: Record<string, unknown>): AutomodFilterEntry[] {
  const raw = settings.entries;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is AutomodFilterEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AutomodFilterEntry).id === "string" &&
      typeof (entry as AutomodFilterEntry).pattern === "string",
  );
}
