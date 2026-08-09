export type ParsedMessageLink = {
  guildId: string;
  channelId: string;
  messageId: string;
};

const MESSAGE_LINK_RE =
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/gi;

export function parseMessageLink(link: string): ParsedMessageLink | null {
  MESSAGE_LINK_RE.lastIndex = 0;
  const match = MESSAGE_LINK_RE.exec(link.trim());
  if (!match) return null;
  return { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}

/** Unique Discord message links found in free text, in order. */
export function extractMessageLinks(text: string): ParsedMessageLink[] {
  const out: ParsedMessageLink[] = [];
  const seen = new Set<string>();
  MESSAGE_LINK_RE.lastIndex = 0;
  for (const match of text.matchAll(MESSAGE_LINK_RE)) {
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ guildId: match[1]!, channelId: match[2]!, messageId: match[3]! });
  }
  return out;
}
