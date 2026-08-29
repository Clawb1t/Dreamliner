/**
 * Thin YouTube Data API v3 client (native fetch, no dependency) used to resolve a creator's
 * handle/URL/ID to a channel and to poll for their latest upload. Requires YOUTUBE_API_KEY.
 */

export class YoutubeResolveError extends Error {}

const API_BASE = "https://www.googleapis.com/youtube/v3";

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
};

async function callChannelsList(params: Record<string, string>): Promise<YoutubeChannelListItem | null> {
  const url = new URL(`${API_BASE}/channels`);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("key", apiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
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
};

/** Normalize a pasted handle, URL, or channel ID into something we can try each API param against. */
function normalizeInput(raw: string): { kind: "id" | "handle" | "legacyUser"; value: string } {
  let value = raw.trim();
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
  };
}

/** Resolve a creator's handle, channel URL, or channel ID to a YouTube channel. */
export async function resolveYoutubeChannel(input: string): Promise<ResolvedYoutubeChannel> {
  const trimmed = input.trim();
  if (!trimmed) throw new YoutubeResolveError("Enter a YouTube handle, channel URL, or channel ID.");

  const normalized = normalizeInput(trimmed);

  let item: YoutubeChannelListItem | null = null;
  if (normalized.kind === "id") {
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

/** Fetch the most recent upload in a channel's uploads playlist, or null if the channel has none. */
export async function fetchLatestUpload(uploadsPlaylistId: string): Promise<LatestUpload | null> {
  const url = new URL(`${API_BASE}/playlistItems`);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", uploadsPlaylistId);
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("key", apiKey());

  const res = await fetch(url.toString());
  if (!res.ok) {
    if (res.status === 403) {
      throw new YoutubeResolveError("YouTube API key is invalid, over quota, or missing the Data API v3.");
    }
    throw new YoutubeResolveError(`YouTube API error (${res.status}).`);
  }
  const data = (await res.json()) as { items?: YoutubePlaylistItem[] };
  const item = data.items?.[0];
  const videoId = item?.contentDetails?.videoId;
  if (!item || !videoId) return null;

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
