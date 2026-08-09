import { translate } from "google-translate-api-x";
import { normalizeLanguageCode } from "../../../core/languages.js";

export const TRANSLATE_MAX_CHARS = 2000;

export type TranslateResult = {
  text: string;
  from: string;
  to: string;
};

const guildCooldownUntil = new Map<string, number>();
const GUILD_COOLDOWN_MS = 750;

export function truncateForTranslate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TRANSLATE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TRANSLATE_MAX_CHARS - 1)}…`;
}

export async function waitGuildTranslateSlot(guildId: string): Promise<void> {
  const until = guildCooldownUntil.get(guildId) ?? 0;
  const now = Date.now();
  if (until > now) {
    await new Promise((resolve) => setTimeout(resolve, until - now));
  }
  guildCooldownUntil.set(guildId, Date.now() + GUILD_COOLDOWN_MS);
}

/** google-translate-api-x returns either a string iso or `{ language: { iso } }` depending on batch mode. */
function extractDetectedIso(from: unknown): string | null {
  if (typeof from === "string" && from.trim() && from !== "auto") {
    return from.trim();
  }
  if (from && typeof from === "object") {
    const language = (from as { language?: { iso?: string } }).language;
    if (typeof language?.iso === "string" && language.iso.trim()) {
      return language.iso.trim();
    }
  }
  return null;
}

export async function translateText(
  text: string,
  to: string,
  from: string | "auto" = "auto",
): Promise<TranslateResult> {
  const input = truncateForTranslate(text);
  if (!input) {
    throw new Error("Nothing to translate.");
  }

  const target = normalizeLanguageCode(to);
  const source = from === "auto" ? "auto" : normalizeLanguageCode(from);

  const result = await translate(input, {
    from: source,
    to: target,
    forceTo: true,
    forceFrom: source !== "auto",
  });

  const detected = extractDetectedIso(result.from) ?? (source === "auto" ? target : source);

  return {
    text: String(result.text ?? "").trim() || input,
    from: normalizeLanguageCode(detected),
    to: target,
  };
}

export async function detectLanguage(text: string): Promise<string | null> {
  const input = truncateForTranslate(text);
  if (!input || input.length < 2) return null;

  const result = await translate(input, {
    from: "auto",
    to: "en",
  });

  const iso = extractDetectedIso(result.from);
  return iso ? normalizeLanguageCode(iso) : null;
}
