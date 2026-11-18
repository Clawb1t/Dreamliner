import { parseIsoDuration } from "./logic.js";

/**
 * Thin YouTube Data API v3 client (native fetch, no dependency) used to resolve a creator's
 * handle/URL/ID to a channel and to poll for their latest upload. Requires YOUTUBE_API_KEY.
 */

export class YoutubeResolveError extends Error {}

const API_BASE = "https://www.googleapis.com/youtube/v3";
/** Every Data API call gives up after this long (a hung request used to stall the whole poll). */
const API_TIMEOUT_MS = 10_000;

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    throw new YoutubeResolveError(
      "YouTube integration isn't configured on this bot yet (missing YOUTUBE_API_KEY).",
    );
  }
  return key;
}

type YoutubeChannelListItem = {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: { high?: { url?: string }; default?: { url?: string } };
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
  brandingSettings?: { image?: { bannerExternalUrl?: string } };
};

/** GET a Data API v3 list endpoint (every call used here costs 1 quota unit). */
async function ytGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set("key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.status === 403) {
      throw new YoutubeResolveError("YouTube API key is invalid, over quota, or missing the Data API v3.");
    }
    throw new YoutubeResolveError(`YouTube API error (${res.status}).`);
  }
  return (await res.json()) as T;
}

async function callChannelsList(params: Record<string, string>): Promise<YoutubeChannelListItem | null> {
  const url = new URL(`${API_BASE}/channels`);
  url.searchParams.set("part", "snippet,contentDetails,statistics");
  url.searchParams.set("key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.status === 403) {
      throw new YoutubeResolveError("YouTube API key is invalid, over quota, or missing the Data API v3.");
    }
    throw new YoutubeResolveError(`YouTube API error (${res.status}).`);
  }
  const data = (await res.json()) as { items?: YoutubeChannelListItem[] };
  return data.items?.[0] ?? null;
}

export type ResolvedYoutubeChannel = {
  channelId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  url: string;
  uploadsPlaylistId: string;
  /** Null when the channel hides its subscriber count. */
  subscriberCount: number | null;
};

/** Normalize a pasted handle, URL, or channel ID into something we can try each API param against. */
function normalizeInput(raw: string): { kind: "id" | "handle" | "legacyUser" | "video"; value: string } {
  let value = raw.trim();
  const videoId = extractVideoId(value);
  if (videoId) return { kind: "video", value: videoId };
  value = value.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "").replace(/\/$/, "");
  value = value.replace(/^@/, "");

  const channelMatch = /^channel\/([\w-]+)/i.exec(value);
  if (channelMatch) return { kind: "id", value: channelMatch[1]! };

  const userMatch = /^(user|c)\/([^/?]+)/i.exec(value);
  if (userMatch) return { kind: "legacyUser", value: userMatch[2]! };

  if (/^UC[\w-]{22}$/.test(value)) return { kind: "id", value };

  // Bare handle, e.g. "@mkbhd" or "mkbhd", or a "@handle" copied without the leading @.
  value = value.split(/[/?#]/)[0]!;
  return { kind: "handle", value };
}

/** A video id from a watch / youtu.be / Shorts / live link, so pasting any video finds its channel. */
export function extractVideoId(raw: string): string | null {
  const value = raw.trim();
  const short = /^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([\w-]{11})/i.exec(value);
  if (short) return short[1]!;
  const path = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/i.exec(value);
  if (path) return path[1]!;
  const watch = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]{11})/i.exec(value);
  if (watch) return watch[1]!;
  return null;
}

function subscriberCountOf(item: YoutubeChannelListItem): number | null {
  if (item.statistics?.hiddenSubscriberCount) return null;
  const raw = item.statistics?.subscriberCount;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toResolvedChannel(item: YoutubeChannelListItem): ResolvedYoutubeChannel | null {
  const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return null;
  const customUrl = item.snippet?.customUrl ?? null;
  return {
    channelId: item.id,
    name: item.snippet?.title ?? item.id,
    handle: customUrl ? (customUrl.startsWith("@") ? customUrl : `@${customUrl}`) : null,
    avatarUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? null,
    url: customUrl ? `https://www.youtube.com/${customUrl.startsWith("@") ? customUrl : `@${customUrl}`}` : `https://www.youtube.com/channel/${item.id}`,
    uploadsPlaylistId,
    subscriberCount: subscriberCountOf(item),
  };
}

/** Resolve a creator's handle, channel URL, or channel ID to a YouTube channel. */
export async function resolveYoutubeChannel(input: string): Promise<ResolvedYoutubeChannel> {
  const trimmed = input.trim();
  if (!trimmed) throw new YoutubeResolveError("Enter a YouTube handle, channel URL, or channel ID.");

  const normalized = normalizeInput(trimmed);

  let item: YoutubeChannelListItem | null = null;
  if (normalized.kind === "video") {
    const details = await fetchVideoDetails([normalized.value]);
    const channelId = details.get(normalized.value)?.channelId;
    if (!channelId) throw new YoutubeResolveError("Couldn't find that video. Paste the channel link instead.");
    item = await callChannelsList({ id: channelId });
  } else if (normalized.kind === "id") {
    item = await callChannelsList({ id: normalized.value });
  } else if (normalized.kind === "legacyUser") {
    item = await callChannelsList({ forUsername: normalized.value });
    if (!item) item = await callChannelsList({ forHandle: `@${normalized.value}` });
  } else {
    item = await callChannelsList({ forHandle: `@${normalized.value}` });
    if (!item) item = await callChannelsList({ forUsername: normalized.value });
  }

  if (!item) {
    throw new YoutubeResolveError(`Couldn't find a YouTube channel for "${trimmed}".`);
  }
  const resolved = toResolvedChannel(item);
  if (!resolved) {
    throw new YoutubeResolveError("That channel is missing an uploads playlist and can't be watched.");
  }
  return resolved;
}

export type LatestUpload = {
  videoId: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  publishedAt: Date;
};

type YoutubePlaylistItem = {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: {
    title?: string;
    publishedAt?: string;
    thumbnails?: { maxres?: { url?: string }; high?: { url?: string }; default?: { url?: string } };
  };
};

function toUpload(item: YoutubePlaylistItem): LatestUpload | null {
  const videoId = item.contentDetails?.videoId;
  if (!videoId) return null;
  const publishedRaw = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
  return {
    videoId,
    title: item.snippet?.title ?? "New video",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl:
      item.snippet?.thumbnails?.maxres?.url ??
      item.snippet?.thumbnails?.high?.url ??
      item.snippet?.thumbnails?.default?.url ??
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    publishedAt: publishedRaw ? new Date(publishedRaw) : new Date(),
  };
}

/**
 * The newest few uploads in a channel's uploads playlist (1 quota unit), newest first. Reading
 * several (not just one) means two uploads close together are both seen.
 */
export async function fetchRecentUploads(uploadsPlaylistId: string, count = 5): Promise<LatestUpload[]> {
  const data = await ytGet<{ items?: YoutubePlaylistItem[] }>("playlistItems", {
    part: "snippet,contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(10, Math.max(1, count))),
  });
  return (data.items ?? []).map(toUpload).filter((u): u is LatestUpload => u !== null);
}

/** The most recent upload in a channel's uploads playlist, or null if the channel has none. */
export async function fetchLatestUpload(uploadsPlaylistId: string): Promise<LatestUpload | null> {
  return (await fetchRecentUploads(uploadsPlaylistId, 1))[0] ?? null;
}

/** The newest few video ids in an uploads playlist (1 quota unit), newest first. */
export async function fetchRecentUploadIds(uploadsPlaylistId: string, count: number): Promise<string[]> {
  const data = await ytGet<{ items?: YoutubePlaylistItem[] }>("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(10, Math.max(1, count))),
  });
  return (data.items ?? []).map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id));
}

// ---------------------------------------------------------------------------------------------
// Batched lookups (videos.list / channels.list take up to 50 ids for 1 quota unit)
// ---------------------------------------------------------------------------------------------

export type VideoDetails = {
  videoId: string;
  channelId: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  publishedAt: Date;
  /** "live", "upcoming" or "none". */
  liveBroadcastContent: string;
  hasLiveStreamingDetails: boolean;
  durationSeconds: number | null;
  scheduledStartAt: Date | null;
};

type YoutubeVideoItem = {
  id: string;
  snippet?: {
    channelId?: string;
    title?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: { maxres?: { url?: string }; high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } };
  };
  contentDetails?: { duration?: string };
  liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string };
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Details for any number of videos, 50 per call (1 unit each). Missing/private videos are left out. */
export async function fetchVideoDetails(videoIds: string[]): Promise<Map<string, VideoDetails>> {
  const out = new Map<string, VideoDetails>();
  const unique = [...new Set(videoIds.filter(Boolean))];
  for (const ids of chunk(unique, 50)) {
    const data = await ytGet<{ items?: YoutubeVideoItem[] }>("videos", {
      part: "snippet,contentDetails,liveStreamingDetails",
      id: ids.join(","),
      maxResults: "50",
    });
    for (const item of data.items ?? []) {
      const thumbs = item.snippet?.thumbnails;
      const scheduled = item.liveStreamingDetails?.scheduledStartTime;
      out.set(item.id, {
        videoId: item.id,
        channelId: item.snippet?.channelId ?? "",
        title: item.snippet?.title ?? "New video",
        url: `https://www.youtube.com/watch?v=${item.id}`,
        thumbnailUrl:
          thumbs?.maxres?.url ??
          thumbs?.high?.url ??
          thumbs?.medium?.url ??
          thumbs?.default?.url ??
          `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
        publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : new Date(),
        liveBroadcastContent: item.snippet?.liveBroadcastContent ?? "none",
        hasLiveStreamingDetails: Boolean(item.liveStreamingDetails),
        durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        scheduledStartAt: scheduled ? new Date(scheduled) : null,
      });
    }
  }
  return out;
}

/**
 * Whether youtube.com/shorts/<id> serves the video as a Short (200) or redirects to /watch (3xx).
 * Not part of the Data API, so it costs no quota. Null when the check couldn't be made.
 */
export async function probeShort(videoId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) return false;
    return null;
  } catch {
    return null;
  }
}

export type ChannelInfo = {
  channelId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  url: string;
  subscriberCount: number | null;
  subscribersHidden: boolean;
  videoCount: number | null;
};

/** Profile + statistics for any number of channels, 50 per call (1 unit each). */
export async function fetchChannelsInfo(channelIds: string[]): Promise<Map<string, ChannelInfo>> {
  const out = new Map<string, ChannelInfo>();
  const unique = [...new Set(channelIds.filter(Boolean))];
  for (const ids of chunk(unique, 50)) {
    const data = await ytGet<{ items?: YoutubeChannelListItem[] }>("channels", {
      part: "snippet,statistics,brandingSettings",
      id: ids.join(","),
      maxResults: "50",
    });
    for (const item of data.items ?? []) {
      const customUrl = item.snippet?.customUrl ?? null;
      const handle = customUrl ? (customUrl.startsWith("@") ? customUrl : `@${customUrl}`) : null;
      const banner = item.brandingSettings?.image?.bannerExternalUrl;
      const videoCount = Number(item.statistics?.videoCount);
      out.set(item.id, {
        channelId: item.id,
        name: item.snippet?.title ?? item.id,
        handle,
        avatarUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? null,
        // The stored banner is the full upload; this size parameter asks for the wide desktop crop.
        bannerUrl: banner ? `${banner}=w1060-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj` : null,
        url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${item.id}`,
        subscriberCount: subscriberCountOf(item),
        subscribersHidden: Boolean(item.statistics?.hiddenSubscriberCount),
        videoCount: Number.isFinite(videoCount) ? videoCount : null,
      });
    }
  }
  return out;
}
