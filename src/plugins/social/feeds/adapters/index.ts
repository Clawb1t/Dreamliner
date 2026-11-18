import type { FeedAdapter, FeedSourceRecord } from "../types.js";
import { rssAdapter } from "./rss.js";
import { steamAdapter } from "./steam.js";
import { riotStatusAdapter } from "./riot.js";
import { rockstarAdapter } from "./rockstar.js";
import { epicFreeAdapter, fortniteAdapter, hoyoverseAdapter, mojangAdapter } from "./games.js";
import { youtubeAdapter } from "./youtube.js";
import { healthCheckAdapter } from "./health.js";

/** Adapter names a source's `config.adapter` can pick (catalogue newswires and status pages). */
export const ADAPTERS = {
  rss: rssAdapter,
  steam: steamAdapter,
  riotStatus: riotStatusAdapter,
  rockstar: rockstarAdapter,
  mojang: mojangAdapter,
  hoyoverse: hoyoverseAdapter,
  fortnite: fortniteAdapter,
  epicFree: epicFreeAdapter,
  youtube: youtubeAdapter,
  healthCheck: healthCheckAdapter,
} as const satisfies Record<string, FeedAdapter>;
export type AdapterName = keyof typeof ADAPTERS;

/** The adapter for a source. Twitch isn't here: it has its own batched live poller (twitch.ts). */
export function adapterFor(source: Pick<FeedSourceRecord, "type" | "config">): FeedAdapter | null {
  const named = source.config.adapter;
  if (typeof named === "string" && named in ADAPTERS) return ADAPTERS[named as AdapterName];
  switch (source.type) {
    case "youtube":
      return youtubeAdapter;
    case "steam":
      return steamAdapter;
    case "rss":
    case "github":
    case "statuspage":
    case "newswire":
      return rssAdapter;
    default:
      return null;
  }
}
