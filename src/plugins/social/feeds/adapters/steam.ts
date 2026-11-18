import { FeedError, type FeedAdapter, type FeedItemInput } from "../types.js";
import { cleanTitle, parseDate, resolveUrl, summarize } from "../text.js";
import { configString, fetchJson } from "./http.js";

type SteamNewsItem = {
  gid?: string;
  title?: string;
  url?: string;
  author?: string;
  contents?: string;
  date?: number;
  tags?: string[];
  feedlabel?: string;
};
export type SteamNewsResponse = { appnews?: { appid?: number; newsitems?: SteamNewsItem[] } };

/** Always with `feeds=steam_community_announcements`: without it Steam mixes in press articles. */
export function steamNewsUrl(appId: string): string {
  return `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${encodeURIComponent(appId)}&count=10&maxlength=300&feeds=steam_community_announcements`;
}

export function steamStoreUrl(appId: string): string {
  return `https://store.steampowered.com/app/${encodeURIComponent(appId)}/`;
}

export function steamHeaderImage(appId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(appId)}/header.jpg`;
}

const CLAN_IMAGES = "https://clan.akamai.steamstatic.com/images";

/** Steam's BBCode-ish markup ([b], [url=...], {STEAM_CLAN_IMAGE}) down to text. */
function steamText(raw: string): string {
  return raw
    .replace(/\{STEAM_CLAN_IMAGE\}\/\S+/g, " ")
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, " ")
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, " ");
}

/** The first image in an announcement body ({STEAM_CLAN_IMAGE} paths, [img] tags, <img>). */
function steamImage(raw: string): string | null {
  const clan = /\{STEAM_CLAN_IMAGE\}(\/[^\s"[\]]+)/.exec(raw);
  if (clan) return resolveUrl(`${CLAN_IMAGES}${clan[1]}`);
  const img = /\[img\]([^[]+)\[\/img\]/i.exec(raw) ?? /<img[^>]+src=["']([^"']+)["']/i.exec(raw);
  return img ? resolveUrl(img[1]!.replace("{STEAM_CLAN_IMAGE}", CLAN_IMAGES)) : null;
}

export function parseSteamNews(data: SteamNewsResponse, appId: string): FeedItemInput[] {
  const items = data?.appnews?.newsitems;
  if (!Array.isArray(items)) throw new FeedError("Steam didn't return news for that app.");
  return items
    .filter((item) => item.gid)
    .map((item) => {
      const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [];
      const contents = item.contents ?? "";
      return {
        key: String(item.gid),
        title: cleanTitle(item.title),
        url: resolveUrl(item.url) ?? steamStoreUrl(appId),
        imageUrl: steamImage(contents) ?? steamHeaderImage(appId),
        summary: summarize(steamText(contents)),
        author: item.author?.trim() || null,
        tags,
        publishedAt: parseDate(item.date),
        payload: { patchNotes: tags.includes("patchnotes") },
      };
    });
}

export const steamAdapter: FeedAdapter = {
  async fetch(source) {
    const appId = configString(source.config, "appId");
    if (!/^\d{1,10}$/.test(appId)) throw new FeedError("This Steam feed has no valid app ID.", { permanent: true });
    const { data } = await fetchJson<SteamNewsResponse>(steamNewsUrl(appId));
    return { items: parseSteamNews(data, appId) };
  },
};

export type SteamSearchResult = { appId: string; name: string; imageUrl: string | null };

type SteamSearchResponse = { items?: { id?: number; name?: string; tiny_image?: string }[] };

export function parseSteamSearch(data: SteamSearchResponse): SteamSearchResult[] {
  return (data?.items ?? [])
    .filter((item) => typeof item.id === "number" && item.name)
    .map((item) => ({ appId: String(item.id), name: item.name!, imageUrl: item.tiny_image ?? null }));
}

/** Steam store search (no key), for the add-a-game typeahead. */
export async function searchSteamApps(query: string, limit = 8): Promise<SteamSearchResult[]> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=en`;
  const { data } = await fetchJson<SteamSearchResponse>(url, { timeoutMs: 8_000 });
  return parseSteamSearch(data).slice(0, limit);
}

/** Name of one app (store appdetails), used when an app ID is pasted directly. */
export async function fetchSteamAppName(appId: string): Promise<string | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic&cc=us&l=en`;
  const { data } = await fetchJson<Record<string, { success?: boolean; data?: { name?: string } }>>(url, { timeoutMs: 8_000 });
  const entry = data?.[appId];
  return entry?.success && entry.data?.name ? entry.data.name : null;
}
