const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

// A bare filename with a common media extension — e.g. someone pastes "clip.mp4" or a GIF
// picker drops in a name like "excited-cat.gif" without a link. Deliberately requires a
// filename-shaped token (word chars/dashes/dots) right before the extension, so it doesn't
// eat ordinary words that happen to end in these letters.
const MEDIA_FILENAME_PATTERN = /\b[\w-]+(?:\.[\w-]+)*\.(?:gif|png|jpe?g|webp|bmp|svg|mp4|mov|webm|avi|mkv)\b/gi;

// Discord's own custom emoji syntax, e.g. <:name:123456789012345678> or <a:name:...> (animated).
const CUSTOM_EMOJI_PATTERN = /<a?:\w+:\d+>/g;

// Unicode emoji: pictographs, flags (regional indicator pairs), skin-tone modifiers, and the
// zero-width-joiner/variation-selector characters that glue multi-codepoint emoji together
// (written as explicit \u escapes, not literal invisible characters, so this stays readable
// and doesn't silently corrupt if something along the way normalizes whitespace).
const ZWJ = "‍";
const VARIATION_SELECTOR_16 = "️";
const UNICODE_EMOJI_PATTERN = new RegExp(
  `[\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}${ZWJ}${VARIATION_SELECTOR_16}\\p{Extended_Pictographic}]`,
  "gu",
);

/**
 * Strips URLs, bare media filenames (gifs, images, video clips), and emoji (both Discord custom
 * emoji and Unicode ones) before text is spoken — none of that reads as anything but noise out
 * loud. Returns "" if nothing meaningful is left (e.g. the whole message was just a link or a
 * string of emoji), which callers treat the same as an empty message.
 */
export function sanitizeSpokenText(text: string): string {
  return text
    .replace(URL_PATTERN, " ")
    .replace(MEDIA_FILENAME_PATTERN, " ")
    .replace(CUSTOM_EMOJI_PATTERN, " ")
    .replace(UNICODE_EMOJI_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}
