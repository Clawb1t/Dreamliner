/** Plain-text body for a neko reply — the image itself is attached separately, not embedded.
 *  Links are wrapped in `<>` so Discord doesn't unfurl them into their own embeds. `successEmoji`
 *  is the guild's configured `emojis.success` (same one used across the bot's other replies). */
export function formatNekoContent(
  artistName: string | null,
  artistHref: string | null,
  successEmoji: string,
): string {
  const name = artistName?.trim() || "an unknown artist";
  const credit = artistHref?.trim() ? `[${name}](<${artistHref.trim()}>)` : name;
  return `${successEmoji} Image by ${credit}\n-# Provided by [Nekos.best](<https://nekos.best>)`;
}

const CREDIT_LINE_RE = /Image by (?:\[(.+?)\]\(<?(.+?)>?\)|(.+))/;

/** Recover the artist credit from a neko message's own content — used when a button click
 *  only has the live message to work with (e.g. saving one after a bot restart). */
export function parseNekoCredit(content: string): { artistName: string | null; artistHref: string | null } {
  const match = CREDIT_LINE_RE.exec(content);
  if (!match) return { artistName: null, artistHref: null };
  if (match[1]) return { artistName: match[1], artistHref: match[2] ?? null };
  const plain = match[3]?.trim();
  return { artistName: plain && plain !== "an unknown artist" ? plain : null, artistHref: null };
}
