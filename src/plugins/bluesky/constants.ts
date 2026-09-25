/** Custom-ID prefix for every Bluesky component, mirroring applications/constants.ts. */
export const BLUESKY_PREFIX = "dl:bsky:";

/** Emojis used across the plugin (app emojis from app-emojis.txt, plus the 💙 the feature is built around). */
export const BLUESKY_EMOJIS = {
  bluesky: "<:Bluesky_Logo:1552933112441344031>",
  like: "💙",
  repost: "<:icons_repeat:1544417397220311040>",
  link: "<:icons_link:1544417328597434500>",
  connect: "<:icons_linkadd:1544417797885657138>",
  disconnect: "<:icons_linkrevoke:1544417799445676062>",
  notify: "<:icons_notify:1544417566708211753>",
  people: "<:icons_people:1544417371215626262>",
  reply: "<:icons_reply:1544417399879770265>",
  quote: "<:icons_quotes:1544417577453748224>",
} as const;

/** Reactions that like a post: blue heart and light blue heart. */
export const LIKE_REACTIONS = new Set(["💙", "🩵"]);

/** Like / Repost on a post card. `deliveryId` is the `bluesky_deliveries` row the card was recorded as. */
export function blueskyLikeId(deliveryId: number): string {
  return `${BLUESKY_PREFIX}like:${deliveryId}`;
}

export function blueskyRepostId(deliveryId: number): string {
  return `${BLUESKY_PREFIX}repost:${deliveryId}`;
}

/** Follow button on a /bluesky profile card. */
export function blueskyFollowId(did: string): string {
  return `${BLUESKY_PREFIX}follow:${did}`;
}

/** Disconnect button on /bluesky account. */
export const BLUESKY_DISCONNECT_ID = `${BLUESKY_PREFIX}disconnect`;

/** Disabled counter button on /bluesky feeds. */
export const BLUESKY_COUNT_ID = `${BLUESKY_PREFIX}stat:total`;

export type ParsedBlueskyCustomId =
  | { kind: "like" | "repost"; deliveryId: number }
  | { kind: "follow"; did: string }
  | { kind: "disconnect" };

export function parseBlueskyCustomId(customId: string): ParsedBlueskyCustomId | null {
  if (!customId.startsWith(BLUESKY_PREFIX)) return null;
  const rest = customId.slice(BLUESKY_PREFIX.length);

  let match = /^(like|repost):(\d+)$/.exec(rest);
  if (match) return { kind: match[1] as "like" | "repost", deliveryId: Number(match[2]) };

  match = /^follow:(did:[a-z]+:[A-Za-z0-9._:%-]+)$/.exec(rest);
  if (match) return { kind: "follow", did: match[1]! };

  if (rest === "disconnect") return { kind: "disconnect" };
  return null;
}
