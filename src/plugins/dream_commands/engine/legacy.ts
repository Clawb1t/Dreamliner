/**
 * Version 2 programs (one reply: text, random text or embed) as version 3 programs with a
 * single Reply step. Migration 0153 does the same conversion in SQL for stored rows; this is the
 * code path for anything still arriving in the old shape (old exports, a row the SQL missed).
 */
import { emptyMessageSpec } from "./fields.js";
import { PROGRAM_VERSION, type CommandProgram } from "./types.js";

type LegacyProgram = {
  version?: number;
  description?: string;
  ephemeral?: boolean;
  responseType?: "text" | "embed";
  random?: boolean;
  content?: string;
  variants?: string[];
  embed?: Record<string, unknown>;
};

const fixTokens = (s: string) => s.replace(/\{mention\}/g, "{user.mention}");

export function upgradeLegacyProgram(input: unknown): CommandProgram {
  const p = (input ?? {}) as LegacyProgram;
  const message = emptyMessageSpec();
  if (p.responseType === "embed") {
    message.format = "embed";
    const e = p.embed ?? {};
    const s = (k: string) => (typeof e[k] === "string" ? fixTokens(e[k] as string) : "");
    message.embed = {
      authorName: s("authorName"),
      authorIconUrl: s("authorIconUrl"),
      authorUrl: s("authorUrl"),
      title: s("title"),
      titleUrl: s("titleUrl"),
      description: s("description"),
      thumbnailUrl: s("thumbnailUrl"),
      imageUrl: s("imageUrl"),
      color: typeof e.color === "number" ? e.color : null,
      footerText: s("footerText"),
      timestamp: e.timestamp === true,
      fields: [],
    };
  } else if (p.random) {
    message.variants = (Array.isArray(p.variants) ? p.variants : []).filter((v) => typeof v === "string").map(fixTokens);
  } else {
    message.content = fixTokens(typeof p.content === "string" ? p.content : "");
  }
  return {
    version: PROGRAM_VERSION,
    description: typeof p.description === "string" && p.description.trim() ? p.description : "Custom command",
    ephemeral: p.ephemeral === true,
    options: [],
    access: { roles: [], rolesMode: "any", blockedRoles: [], permissions: [], channels: [], blockedChannels: [], visibility: [] },
    cooldowns: { user: 0, channel: 0, global: 0 },
    limits: { perUserDaily: 0, guildDaily: 0 },
    steps: [{ id: "step1", type: "reply", config: { ephemeral: "default", message } }],
  };
}

/** Parses a stored program column, upgrading old shapes. */
export function parseStoredProgram(raw: string): CommandProgram {
  try {
    const parsed = JSON.parse(raw) as { version?: number };
    if (parsed && parsed.version === PROGRAM_VERSION) return parsed as CommandProgram;
    return upgradeLegacyProgram(parsed);
  } catch {
    return upgradeLegacyProgram({});
  }
}
