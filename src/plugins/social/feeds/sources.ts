/**
 * Turning what a user picked (a creator, a URL, a Steam game, a repo, a catalogue entry) into a
 * feed source, previewing it, and seeding it so following it never posts anything retroactively.
 */
import { z } from "zod";
import { YoutubeResolveError, fetchRecentUploads, resolveYoutubeChannel } from "../functions/youtube.js";
import { TwitchResolveError, fetchLiveStream, resolveTwitchUser } from "../functions/twitch.js";
import { SafeFetchError, safeFetch } from "../../../core/safeFetch.js";
import { cached } from "../../../bridge/responseCache.js";
import { adapterFor } from "./adapters/index.js";
import { FEED_ACCEPT_XML, toFeedError } from "./adapters/http.js";
import { fetchSteamAppName, steamHeaderImage, steamStoreUrl } from "./adapters/steam.js";
import { FeedParseError, parseFeed, decodeFeedBody } from "./parser.js";
import { catalogDisplayName, catalogSourceKey, getCatalogEntry } from "./catalog.js";
import { normalizeLink, resolveUrl } from "./text.js";
import { streamToItem } from "./twitch.js";
import { refreshSource } from "./poller.js";
import { FeedError, type FeedItemInput, type FeedSourceType } from "./types.js";
import { latestItems, maxItemId, updateSource, upsertItem, upsertSource, type FeedSourceRow, type SourceInput } from "./store.js";

export const DEFAULT_INTERVALS: Record<FeedSourceType, number> = {
  youtube: 300,
  twitch: 120,
  rss: 900,
  steam: 1200,
  github: 1800,
  statuspage: 300,
  newswire: 1800,
};

/** What the dashboard sends to pick a source. */
export const zFeedSourceSpec = z.union([
  z.object({ catalogKey: z.string().min(1).max(64), region: z.string().max(16).optional() }),
  z.object({ type: z.literal("youtube"), input: z.string().min(1).max(300) }),
  z.object({ type: z.literal("twitch"), input: z.string().min(1).max(300) }),
  z.object({ type: z.literal("rss"), url: z.string().min(1).max(1000) }),
  z.object({ type: z.literal("steam"), appId: z.string().min(1).max(300) }),
  z.object({ type: z.literal("github"), repo: z.string().min(1).max(300) }),
  z.object({ type: z.literal("statuspage"), url: z.string().min(1).max(1000) }),
]);
export type FeedSourceSpec = z.infer<typeof zFeedSourceSpec>;

export class SourceResolveError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

function wrapLookup(error: unknown): never {
  if (error instanceof SourceResolveError) throw error;
  if (error instanceof YoutubeResolveError || error instanceof TwitchResolveError) throw new SourceResolveError(error.message);
  if (error instanceof FeedError) throw new SourceResolveError(error.message);
  if (error instanceof SafeFetchError) throw new SourceResolveError(toFeedError(error).message);
  throw error;
}

/** A pasted feed URL made fetchable: https:// added when missing, the fragment dropped. Path kept as typed. */
export function normalizeFeedUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const url = resolveUrl(withScheme);
  if (!url) throw new SourceResolveError("Enter a valid http(s) feed URL.", 400);
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

/** The source key for a feed URL: lowercase host, no tracking params, no trailing slash. */
export function feedUrlKey(url: string): string {
  return normalizeLink(url);
}

export function parseGithubRepo(raw: string): { owner: string; repo: string } {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/(releases|tags)(\.atom)?\/?.*$/i, "")
    .replace(/\/$/, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned);
  if (!match) throw new SourceResolveError("Enter a GitHub repository as owner/repo.", 400);
  return { owner: match[1]!, repo: match[2]! };
}

export function parseSteamAppId(raw: string): string | null {
  const value = raw.trim();
  if (/^\d{1,10}$/.test(value)) return value;
  const match = /store\.steampowered\.com\/app\/(\d{1,10})/i.exec(value) ?? /steamcommunity\.com\/app\/(\d{1,10})/i.exec(value);
  return match ? match[1]! : null;
}

/** A statuspage domain or URL to its incident history feed. */
export function statuspageFeedUrl(raw: string): string {
  const normalized = normalizeFeedUrl(raw);
  const url = new URL(normalized);
  if (/\/history\.(rss|atom)$/i.test(url.pathname) || /\/(rss|feed)\/?$/i.test(url.pathname)) return normalized;
  return `${url.protocol}//${url.host}/history.rss`;
}

/** Find a page's RSS/Atom alternate link, so pasting a site URL works too. */
function discoverFeedLink(html: string, base: string): string | null {
  const re = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const tag = match[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const url = resolveUrl(href, base);
    if (url) return url;
  }
  return null;
}

type Resolved = { input: SourceInput; previewItems?: FeedItemInput[] };

/** Fetch and parse an RSS URL (following a page's feed link once). */
async function probeRss(url: string): Promise<{ url: string; title: string; siteUrl: string | null; iconUrl: string | null; items: FeedItemInput[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await safeFetch(url, { accept: [...FEED_ACCEPT_XML, "html"] }).catch(wrapLookup);
    try {
      const feed = parseFeed(result.body, result.url, result.contentType);
      return { url, title: feed.title, siteUrl: feed.siteUrl, iconUrl: feed.iconUrl, items: feed.items };
    } catch (error) {
      if (!(error instanceof FeedParseError)) throw error;
      const text = decodeFeedBody(result.body, result.contentType);
      const link = attempt === 0 ? discoverFeedLink(text.slice(0, 200_000), result.url) : null;
      if (!link) throw new SourceResolveError(error.message);
      url = normalizeFeedUrl(link);
    }
  }
  throw new SourceResolveError("That isn't an RSS or Atom feed.");
}

/** Resolve a spec to the source it maps to. Network lookups are cached for a few minutes. */
export async function resolveSourceSpec(spec: FeedSourceSpec): Promise<Resolved> {
  try {
    if ("catalogKey" in spec) {
      const entry = getCatalogEntry(spec.catalogKey);
      if (!entry) throw new SourceResolveError("That newswire isn't in the catalogue.", 404);
      // Creators are ordinary YouTube sources: the same one a server gets by pasting the channel.
      if (entry.type === "youtube") return await resolveSourceSpec({ type: "youtube", input: String(entry.config.channelId) });
      const region = entry.regions ? spec.region : undefined;
      if (entry.regions && (!region || !entry.regions.some((r) => r.value === region))) {
        throw new SourceResolveError("Pick a region for this feed.", 400);
      }
      return {
        input: {
          type: entry.type,
          key: catalogSourceKey(entry, region),
          config: { ...entry.config, adapter: entry.adapter, catalogKey: entry.key, ...(region ? { region } : {}) },
          title: catalogDisplayName(entry, region),
          iconUrl: entry.type === "steam" ? steamHeaderImage(String(entry.config.appId)) : entry.iconUrl,
          siteUrl: entry.siteUrl,
          intervalS: entry.intervalS,
        },
      };
    }
    switch (spec.type) {
      case "youtube": {
        const channel = await cached(`feeds:yt:${spec.input.trim().toLowerCase()}`, 10 * 60_000, () => resolveYoutubeChannel(spec.input));
        return {
          input: {
            type: "youtube",
            key: `youtube:${channel.channelId}`,
            config: { channelId: channel.channelId, uploadsPlaylistId: channel.uploadsPlaylistId, handle: channel.handle },
            title: channel.name,
            iconUrl: channel.avatarUrl,
            siteUrl: channel.url,
            intervalS: DEFAULT_INTERVALS.youtube,
          },
        };
      }
      case "twitch": {
        const user = await cached(`feeds:tw:${spec.input.trim().toLowerCase()}`, 10 * 60_000, () => resolveTwitchUser(spec.input));
        return {
          input: {
            type: "twitch",
            key: `twitch:${user.userId}`,
            config: { userId: user.userId, login: user.login },
            title: user.displayName,
            iconUrl: user.avatarUrl,
            siteUrl: user.url,
            intervalS: DEFAULT_INTERVALS.twitch,
          },
        };
      }
      case "rss": {
        const probed = await cached(`feeds:rss:${feedUrlKey(normalizeFeedUrl(spec.url))}`, 5 * 60_000, () => probeRss(normalizeFeedUrl(spec.url)));
        const host = new URL(probed.url).hostname.replace(/^www\./, "");
        return {
          input: {
            type: "rss",
            key: `rss:${feedUrlKey(probed.url)}`,
            config: { url: probed.url },
            title: probed.title || host,
            iconUrl: probed.iconUrl,
            siteUrl: probed.siteUrl ?? `https://${host}/`,
            intervalS: DEFAULT_INTERVALS.rss,
          },
          previewItems: probed.items,
        };
      }
      case "statuspage": {
        const url = statuspageFeedUrl(spec.url);
        const probed = await cached(`feeds:rss:${url}`, 5 * 60_000, () => probeRss(url));
        return {
          input: {
            type: "statuspage",
            key: `statuspage:${feedUrlKey(probed.url)}`,
            config: { url: probed.url },
            title: probed.title.replace(/\s*-\s*Incident History$/i, "") || new URL(probed.url).hostname,
            iconUrl: probed.iconUrl,
            siteUrl: probed.siteUrl ?? `${new URL(probed.url).origin}/`,
            intervalS: DEFAULT_INTERVALS.statuspage,
          },
          previewItems: probed.items,
        };
      }
      case "github": {
        const { owner, repo } = parseGithubRepo(spec.repo);
        const url = `https://github.com/${owner}/${repo}/releases.atom`;
        const probed = await cached(`feeds:rss:${url.toLowerCase()}`, 5 * 60_000, () => probeRss(url)).catch((error: unknown) => {
          if (error instanceof SourceResolveError && /404|answered 4/.test(error.message)) {
            throw new SourceResolveError("That repository doesn't exist or is private.");
          }
          throw error;
        });
        return {
          input: {
            type: "github",
            key: `github:${owner.toLowerCase()}/${repo.toLowerCase()}`,
            config: { owner, repo },
            title: `${owner}/${repo}`,
            iconUrl: `https://github.com/${encodeURIComponent(owner)}.png?size=128`,
            siteUrl: `https://github.com/${owner}/${repo}/releases`,
            intervalS: DEFAULT_INTERVALS.github,
          },
          previewItems: probed.items,
        };
      }
      case "steam": {
        const appId = parseSteamAppId(spec.appId);
        if (!appId) throw new SourceResolveError("Pick a Steam game (or paste its store link or app ID).", 400);
        const name = await cached(`feeds:steam-name:${appId}`, 60 * 60_000, () => fetchSteamAppName(appId)).catch(() => null);
        if (!name) throw new SourceResolveError("Steam doesn't have a game with that app ID.");
        return {
          input: {
            type: "steam",
            key: `steam:${appId}`,
            config: { appId },
            title: name,
            iconUrl: steamHeaderImage(appId),
            siteUrl: steamStoreUrl(appId),
            intervalS: DEFAULT_INTERVALS.steam,
          },
        };
      }
    }
  } catch (error) {
    wrapLookup(error);
  }
}

export type SourcePreview = {
  type: FeedSourceType;
  key: string;
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  items: Pick<FeedItemInput, "key" | "title" | "url" | "imageUrl" | "summary" | "author" | "tags" | "publishedAt">[];
  /** Whether another server already follows this source (so it's shared and instant). */
  existing: boolean;
};

const PREVIEW_ITEMS = 5;

function sortNewest(items: FeedItemInput[]): FeedItemInput[] {
  return [...items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/** Validate a spec and show its latest items, without creating anything. */
export async function previewSourceSpec(spec: FeedSourceSpec, existingSource: FeedSourceRow | null): Promise<SourcePreview> {
  const resolved = await resolveSourceSpec(spec);
  const { input } = resolved;
  let items: FeedItemInput[] = resolved.previewItems ?? [];
  if (!resolved.previewItems) {
    if (existingSource && existingSource.lastOkAt) {
      items = latestItems(existingSource.id, PREVIEW_ITEMS).map((row) => ({ ...row, key: row.itemKey }));
    } else if (input.type === "twitch") {
      const stream = await fetchLiveStream(String(input.config.userId)).catch(() => null);
      items = stream ? [streamToItem(stream)] : [];
    } else if (input.type === "youtube") {
      const uploads = await cached(`feeds:yt-recent:${String(input.config.uploadsPlaylistId)}`, 5 * 60_000, () =>
        fetchRecentUploads(String(input.config.uploadsPlaylistId), PREVIEW_ITEMS),
      ).catch(wrapLookup);
      items = uploads.map((u) => ({ key: u.videoId, title: u.title, url: u.url, imageUrl: u.thumbnailUrl, summary: "", author: input.title, tags: [], publishedAt: u.publishedAt }));
    } else {
      const adapter = adapterFor({ type: input.type, config: input.config });
      if (adapter) {
        const result = await cached(`feeds:preview:${input.key}`, 5 * 60_000, () =>
          adapter.fetch({ id: 0, type: input.type, key: input.key, config: input.config, title: input.title, iconUrl: input.iconUrl, siteUrl: input.siteUrl, etag: null, lastModified: null, contentHash: null }),
        ).catch(wrapLookup);
        items = result.notModified ? [] : result.items;
      }
    }
  }
  return {
    type: input.type,
    key: input.key,
    title: input.title,
    iconUrl: input.iconUrl,
    siteUrl: input.siteUrl,
    items: sortNewest(items)
      .slice(0, PREVIEW_ITEMS)
      .map(({ key, title, url, imageUrl, summary, author, tags, publishedAt }) => ({ key, title, url, imageUrl, summary, author, tags, publishedAt })),
    existing: Boolean(existingSource),
  };
}

/**
 * Create (or reuse) the source and make sure it has a baseline, so a new subscription starts
 * from what's there now. Returns the source and its newest item id (the subscription's cursor).
 */
export async function ensureSeededSource(resolved: Resolved): Promise<{ source: FeedSourceRow; seedError: string | null }> {
  let source = await upsertSource(resolved.input);
  let seedError: string | null = null;
  if (source.type === "twitch") {
    // Seed with the stream that's live right now (if any), so adding a feed mid-stream is quiet.
    const stream = await fetchLiveStream(String(source.config.userId)).catch(() => null);
    if (stream) await upsertItem(source.id, streamToItem(stream), true);
    if (!source.lastOkAt) {
      await updateSource(source.id, {
        lastOkAt: new Date(),
        state: { ...source.state, streamId: stream?.streamId ?? null, lastSeenLiveAt: stream ? Date.now() : null },
      });
    }
  } else if (!source.lastOkAt) {
    const result = await refreshSource(source);
    if (!result.ok) seedError = result.error;
  }
  source = (await upsertSource(resolved.input)) ?? source;
  return { source, seedError };
}

export { maxItemId };
