/**
 * Thin Twitch Helix API client (native fetch, no dependency) used to resolve a streamer's login
 * to a user and to poll whether they're currently live. Requires TWITCH_CLIENT_ID and
 * TWITCH_CLIENT_SECRET (a Twitch Developer Console app). Uses an app access token
 * (client_credentials grant) — no per-user Twitch login is ever needed.
 */

export class TwitchResolveError extends Error {}

const API_BASE = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
/** Every Helix call gives up after this long. */
const API_TIMEOUT_MS = 10_000;

function clientId(): string {
  const id = process.env.TWITCH_CLIENT_ID?.trim();
  if (!id) {
    throw new TwitchResolveError(
      "Twitch integration isn't configured on this bot yet (missing TWITCH_CLIENT_ID).",
    );
  }
  return id;
}

function clientSecret(): string {
  const secret = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!secret) {
    throw new TwitchResolveError(
      "Twitch integration isn't configured on this bot yet (missing TWITCH_CLIENT_SECRET).",
    );
  }
  return secret;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAppAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const url = new URL(TOKEN_URL);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("client_secret", clientSecret());
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    throw new TwitchResolveError(`Twitch auth error (${res.status}). Check TWITCH_CLIENT_ID/SECRET.`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function helixGet(path: string, params: Record<string, string | string[]>): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, value);
  }

  const token = await getAppAccessToken();
  const res = await fetch(url.toString(), {
    headers: { "Client-Id": clientId(), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 401) {
    // Token may have been revoked/expired early; retry once with a fresh one.
    cachedToken = null;
    const retryToken = await getAppAccessToken();
    const retryRes = await fetch(url.toString(), {
      headers: { "Client-Id": clientId(), Authorization: `Bearer ${retryToken}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!retryRes.ok) throw new TwitchResolveError(`Twitch API error (${retryRes.status}).`);
    return retryRes.json();
  }
  if (!res.ok) {
    throw new TwitchResolveError(`Twitch API error (${res.status}).`);
  }
  return res.json();
}

type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
};

export type ResolvedTwitchUser = {
  userId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
};

/** Normalize a pasted Twitch handle, URL, or bare login into a login name. */
function normalizeInput(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/$/, "");
  value = value.replace(/^@/, "");
  return value.split(/[/?#]/)[0]!.toLowerCase();
}

/** Resolve a creator's login, channel URL, or @handle to a Twitch user. */
export async function resolveTwitchUser(input: string): Promise<ResolvedTwitchUser> {
  const trimmed = input.trim();
  if (!trimmed) throw new TwitchResolveError("Enter a Twitch username or channel URL.");

  const login = normalizeInput(trimmed);
  if (!login) throw new TwitchResolveError("Enter a Twitch username or channel URL.");

  const data = (await helixGet("/users", { login })) as { data?: TwitchUser[] };
  const user = data.data?.[0];
  if (!user) throw new TwitchResolveError(`Couldn't find a Twitch channel for "${trimmed}".`);

  return {
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
    avatarUrl: user.profile_image_url ?? null,
    url: `https://www.twitch.tv/${user.login}`,
  };
}

export type LiveStream = {
  streamId: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  gameName: string;
  viewerCount: number;
  startedAt: Date;
};

type TwitchStream = {
  id: string;
  title?: string;
  game_name?: string;
  viewer_count?: number;
  started_at?: string;
  thumbnail_url?: string;
  user_login: string;
};

/** Fetch the current live stream for a user, or null if they're offline. */
export async function fetchLiveStream(userId: string): Promise<LiveStream | null> {
  const data = (await helixGet("/streams", { user_id: userId })) as { data?: TwitchStream[] };
  const stream = data.data?.[0];
  if (!stream) return null;

  return {
    streamId: stream.id,
    title: stream.title ?? "Live now",
    url: `https://www.twitch.tv/${stream.user_login}`,
    thumbnailUrl: (stream.thumbnail_url ?? "").replace("{width}", "1280").replace("{height}", "720"),
    gameName: stream.game_name ?? "",
    viewerCount: stream.viewer_count ?? 0,
    startedAt: stream.started_at ? new Date(stream.started_at) : new Date(),
  };
}

// ---------------------------------------------------------------------------------------------
// Batched lookups (Helix takes up to 100 ids per call; all of these work with the app token)
// ---------------------------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type TwitchStreamWithUser = TwitchStream & { user_id: string };

function toLiveStream(stream: TwitchStream): LiveStream {
  return {
    streamId: stream.id,
    title: stream.title ?? "Live now",
    url: `https://www.twitch.tv/${stream.user_login}`,
    thumbnailUrl: (stream.thumbnail_url ?? "").replace("{width}", "1280").replace("{height}", "720"),
    gameName: stream.game_name ?? "",
    viewerCount: stream.viewer_count ?? 0,
    startedAt: stream.started_at ? new Date(stream.started_at) : new Date(),
  };
}

/** Live streams for many users at once, keyed by user id. Offline users are simply absent. */
export async function fetchLiveStreams(userIds: string[]): Promise<Map<string, LiveStream>> {
  const out = new Map<string, LiveStream>();
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const ids of chunk(unique, 100)) {
    const data = (await helixGet("/streams", { user_id: ids, first: "100" })) as { data?: TwitchStreamWithUser[] };
    for (const stream of data.data ?? []) out.set(stream.user_id, toLiveStream(stream));
  }
  return out;
}

export type TwitchUserInfo = {
  userId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  /** The image Twitch shows while they're offline; the closest thing to a channel banner. */
  offlineImageUrl: string | null;
  description: string;
  url: string;
};

type TwitchUserFull = TwitchUser & { offline_image_url?: string; description?: string };

/** Profiles for many users at once, keyed by user id. */
export async function fetchTwitchUsers(userIds: string[]): Promise<Map<string, TwitchUserInfo>> {
  const out = new Map<string, TwitchUserInfo>();
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const ids of chunk(unique, 100)) {
    const data = (await helixGet("/users", { id: ids })) as { data?: TwitchUserFull[] };
    for (const user of data.data ?? []) {
      out.set(user.id, {
        userId: user.id,
        login: user.login,
        displayName: user.display_name,
        avatarUrl: user.profile_image_url || null,
        offlineImageUrl: user.offline_image_url || null,
        description: (user.description ?? "").slice(0, 300),
        url: `https://www.twitch.tv/${user.login}`,
      });
    }
  }
  return out;
}

export type TwitchSearchChannel = {
  userId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  isLive: boolean;
  gameName: string;
};

type TwitchSearchResult = {
  id: string;
  broadcaster_login: string;
  display_name: string;
  thumbnail_url?: string;
  is_live?: boolean;
  game_name?: string;
};

/** Channel name search (Helix search/channels), for the add-a-creator typeahead. */
export async function searchTwitchChannels(query: string, limit = 8): Promise<TwitchSearchChannel[]> {
  const data = (await helixGet("/search/channels", { query, first: String(Math.min(20, limit)) })) as {
    data?: TwitchSearchResult[];
  };
  return (data.data ?? []).slice(0, limit).map((c) => ({
    userId: c.id,
    login: c.broadcaster_login,
    displayName: c.display_name,
    avatarUrl: c.thumbnail_url || null,
    isLive: Boolean(c.is_live),
    gameName: c.game_name ?? "",
  }));
}

type TwitchVideo = { id: string; stream_id?: string | null; url?: string; duration?: string };

/** The VOD (past broadcast) of a stream, if the channel saves them and it's published yet. */
export async function fetchStreamVod(userId: string, streamId: string): Promise<string | null> {
  const data = (await helixGet("/videos", { user_id: userId, type: "archive", first: "5" })) as { data?: TwitchVideo[] };
  const match = (data.data ?? []).find((video) => video.stream_id === streamId);
  return match ? (match.url ?? `https://www.twitch.tv/videos/${match.id}`) : null;
}
