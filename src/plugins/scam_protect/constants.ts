/**
 * Obfuscated honeypot base name (looks like "scamprotect").
 * Built with Unicode escapes so the file encoding cannot flatten lookalikes to ASCII.
 *
 *   с U+0441, а U+0430, р U+0440, е U+0435, с U+0441
 */
export const SCAM_PROTECT_CHANNEL_BASE = "s\u0441\u0430m\u0440rot\u0435\u0441t";

/**
 * Fallback if Discord collapses Cyrillic lookalikes to ASCII.
 * Fullwidth Latin letters still read as "scamprotect" but are not plain ASCII.
 */
export const SCAM_PROTECT_CHANNEL_BASE_FULLWIDTH =
  "\uff53\uff43\uff41\uff4d\uff50\uff52\uff4f\uff54\uff45\uff43\uff54";

export const SCAM_PROTECT_STATS_PREFIX = "dl:scamprotect:stats";

/** Final honeypot channel name: optional dashboard prefix + obfuscated base. */
export function scamProtectChannelName(prefix = ""): string {
  const trimmed = prefix.trim();
  return `${trimmed}${SCAM_PROTECT_CHANNEL_BASE}`.slice(0, 100);
}

export function scamProtectChannelNameFullwidth(prefix = ""): string {
  const trimmed = prefix.trim();
  return `${trimmed}${SCAM_PROTECT_CHANNEL_BASE_FULLWIDTH}`.slice(0, 100);
}

export function channelNameHasObfuscation(name: string): boolean {
  return [...name].some((ch) => (ch.codePointAt(0) ?? 0) > 127);
}
