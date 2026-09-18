import { PROFANITY_WORDS } from "../plugins/automod/functions/packs/profanity.js";
import { SLUR_WORDS } from "../plugins/automod/functions/packs/slurs.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Reuses Automod's own word packs so there's one source of truth for what counts as a bad word,
// rather than a second hand-maintained list drifting out of sync with it.
const CENSOR_WORDS = [...new Set([...PROFANITY_WORDS, ...SLUR_WORDS])];
const CENSOR_PATTERN = new RegExp(`\\b(?:${CENSOR_WORDS.map(escapeRegex).join("|")})\\b`, "gi");

/**
 * Replaces every whole-word match of the bot's bad-word list with `#` characters of the same
 * length (e.g. "fuck" -> "####"). Applied to the bot's own command response text right before
 * it's rendered, so a swear typed into a reason/note or echoed back from user-supplied content
 * never shows up uncensored in a reply.
 *
 * Deliberately simple, exact-spelling, word-boundary matching — not the leetspeak/fuzzy matching
 * Automod's detector uses on incoming messages (see automod/functions/detectors/wordMatch.ts).
 * This is a display-time safety net for the bot's own output, not a moderation detector, so it
 * doesn't need to (and shouldn't try to) catch deliberate evasion.
 */
export function censorProfanity(text: string): string;
export function censorProfanity(text: string | undefined): string | undefined;
export function censorProfanity(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(CENSOR_PATTERN, (match) => "#".repeat(match.length));
}
