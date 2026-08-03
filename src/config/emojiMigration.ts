import type { EmojisConfig } from "./schemas/guild.js";

/** Old Dreamliner default emoji markup → current defaults. */
export const LEGACY_EMOJI_REPLACEMENTS: Record<string, string> = {
  "<:checked:1524379445379465276>": "<:blurplecheck:1533947878668763278>",
  "<:redcheck:1524379423757959208>": "<:redcheck:1533947951481749504>",
  "<:greycheck:1524379394372669553>": "<:greycheck:1533948078615298148>",
  "<:lowwarning:1524379341000151170>": "<:warning:1533948583995244734>",
  "<:unchecked:1524379366996312104>": "<:greycheck:1533948078615298148>",
};

const EMOJI_KEYS = ["success", "error", "neutral", "warning", "unchecked"] as const;

export function migrateLegacyEmojis(emojis: EmojisConfig): { emojis: EmojisConfig; changed: boolean } {
  let changed = false;
  const next: EmojisConfig = { ...emojis };

  for (const key of EMOJI_KEYS) {
    const current = next[key];
    const replacement = current ? LEGACY_EMOJI_REPLACEMENTS[current] : undefined;
    if (replacement) {
      next[key] = replacement;
      changed = true;
    }
  }

  return { emojis: next, changed };
}

/** Remap legacy emoji strings anywhere in a parsed user-overrides object. */
export function migrateLegacyEmojisInObject(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const replacement = LEGACY_EMOJI_REPLACEMENTS[value];
    return replacement ? { value: replacement, changed: true } : { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const migrated = migrateLegacyEmojisInObject(item);
      if (migrated.changed) changed = true;
      return migrated.value;
    });
    return { value: next, changed };
  }

  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const migrated = migrateLegacyEmojisInObject(child);
      if (migrated.changed) changed = true;
      next[key] = migrated.value;
    }
    return { value: next, changed };
  }

  return { value, changed: false };
}
