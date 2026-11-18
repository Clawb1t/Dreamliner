import { getLogger } from "../../../core/logger.js";
import { safeFetch } from "../../../core/safeFetch.js";
import { ADAPTERS } from "./adapters/index.js";
import { FEED_CATALOG, type CatalogEntry } from "./catalog.js";
import type { FeedSourceRecord } from "./types.js";

const log = getLogger("social:banners");

/**
 * Discover page banners. Steam entries carry the game's own header art (artUrl). Every other
 * catalogue entry uses the image of its newest post (a GTA VI article's art, a patch note's
 * banner, a news site's lead story, a creator's latest video thumbnail), fetched in the background
 * and cached here so the catalogue route never waits on a remote feed. YouTube creators are read
 * from their public uploads feed through the rss adapter (media:thumbnail), so no API key is
 * needed. Status pages have no images and stay null (the site shows a flat banner with the logo).
 */

export const BANNER_REFRESH_MS = 6 * 60 * 60_000;
const SPACING_MS = 1500;

const cache = new Map<string, string>();
let refreshing = false;

/** The banner for a catalogue entry: its own art, else the cached newest-post image, else null. */
export function catalogBanner(entry: CatalogEntry): string | null {
  return entry.artUrl ?? cache.get(entry.key) ?? null;
}

/** How many catalogue entries have a banner right now (own art or a cached post image). */
export function catalogBannerCount(): number {
  return FEED_CATALOG.filter((e) => catalogBanner(e)).length;
}

function sourceFor(entry: CatalogEntry): FeedSourceRecord {
  return {
    id: 0,
    type: entry.type,
    key: `banner:${entry.key}`,
    config: { ...entry.config, adapter: entry.adapter },
    title: entry.name,
    iconUrl: entry.iconUrl,
    siteUrl: entry.siteUrl,
    etag: null,
    lastModified: null,
    contentHash: null,
  };
}

/** A YouTube RSS thumbnail (4:3 hqdefault, letterboxed) to the 16:9 HD frame when the video has one. */
export function youtubeWideThumbnail(url: string): { hd: string; fallback: string } | null {
  const id = /\/vi\/([\w-]{6,20})\//.exec(url)?.[1];
  if (!id || !/ytimg\.com$/i.test(new URL(url).hostname)) return null;
  return { hd: `https://i.ytimg.com/vi/${id}/hq720.jpg`, fallback: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
}

async function wideYoutube(url: string): Promise<string> {
  const wide = youtubeWideThumbnail(url);
  if (!wide) return url;
  try {
    await safeFetch(wide.hd, { accept: ["image/"], maxBytes: 1024 * 1024 });
    return wide.hd;
  } catch {
    return wide.fallback;
  }
}

async function fetchBanner(entry: CatalogEntry): Promise<string | null> {
  const adapter = ADAPTERS[entry.adapter];
  if (!adapter) return null;
  const result = await adapter.fetch(sourceFor(entry));
  if ("notModified" in result && result.notModified) return null;
  const items = "items" in result ? result.items : [];
  const newestFirst = [...items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  const withImage = newestFirst.find((item) => item.imageUrl && /^https:\/\//i.test(item.imageUrl));
  if (!withImage?.imageUrl) return null;
  return entry.type === "youtube" ? wideYoutube(withImage.imageUrl) : withImage.imageUrl;
}

/** Refreshes every banner that comes from a feed, one source at a time. Safe to call repeatedly. */
export async function refreshCatalogBanners(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const entry of FEED_CATALOG) {
      if (entry.artUrl || entry.category === "status") continue;
      try {
        const url = await fetchBanner(entry);
        if (url) cache.set(entry.key, url);
      } catch (error) {
        log.debug(`[social] banner for ${entry.key} failed:`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
    }
  } finally {
    refreshing = false;
  }
}
