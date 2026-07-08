export type ParsedMessageLink = {
  guildId: string;
  channelId: string;
  messageId: string;
};

export function parseMessageLink(link: string): ParsedMessageLink | null {
  const match = link.trim().match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) return null;
  return { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}
