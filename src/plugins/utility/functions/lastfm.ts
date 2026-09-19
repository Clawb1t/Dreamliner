/**
 * Thin client for the Last.fm API (native fetch, no dependency) — used by the "Listening to" user
 * context command to read what a connected member is playing, and by the website's Connections
 * tab to validate a typed username before saving it. Requires LASTFM_API_KEY.
 */

import { getLogger } from "../../../core/logger.js";

const log = getLogger("utility");

const API_BASE = "https://ws.audioscrobbler.com/2.0/";
/** Last.fm's grey "no album art" placeholder — same hash on every size variant. */
const NO_ART_HASH = "2a96cbd8b46e442fc41c2b86b821562f";
const TIMEOUT_MS = 8000;
const USERNAME_RE = /^[A-Za-z0-9_\-.]+$/;
const MAX_USERNAME_LENGTH = 60;

export class LastfmError extends Error {}

function apiKey(): string {
  const key = process.env.LASTFM_API_KEY?.trim();
  if (!key) {
    throw new LastfmError("Last.fm isn't configured on this bot yet.");
  }
  return key;
}

type LastfmErrorBody = { error?: number; message?: string };

async function callLastfm<T>(method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(API_BASE);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", apiKey());
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    log.error(`Last.fm ${method} network error:`, error);
    throw new LastfmError("Couldn't reach Last.fm right now.");
  }

  if (!res.ok) {
    log.error(`Last.fm ${method} HTTP error:`, res.status);
    throw new LastfmError("Last.fm is having issues right now.");
  }

  const body = (await res.json().catch(() => ({}))) as T & LastfmErrorBody;

  // Last.fm returns HTTP 200 with a JSON `error` code for bad input, not an HTTP error status.
  if (typeof body.error === "number") {
    if (body.error === 6) {
      throw new LastfmError("NOT_FOUND");
    }
    log.error(`Last.fm ${method} rejected the request:`, body.error, body.message);
    throw new LastfmError("Last.fm rejected this request (the bot's API key may be invalid, or Last.fm is rate-limiting it).");
  }

  return body;
}

export type LastfmUserCheck = { ok: true; name: string } | { ok: false; reason: "not_found" };

type UserInfoBody = { user?: { name?: string } };

/** user.getinfo — validates a typed username; returns Last.fm's canonical-cased name on success. */
export async function getLastfmUserInfo(username: string): Promise<LastfmUserCheck> {
  const trimmed = username.trim();
  if (!trimmed || trimmed.length > MAX_USERNAME_LENGTH || !USERNAME_RE.test(trimmed)) {
    return { ok: false, reason: "not_found" };
  }

  let body: UserInfoBody;
  try {
    body = await callLastfm<UserInfoBody>("user.getinfo", { user: trimmed });
  } catch (error) {
    if (error instanceof LastfmError && error.message === "NOT_FOUND") {
      return { ok: false, reason: "not_found" };
    }
    throw error;
  }

  const name = body.user?.name?.trim();
  if (!name) return { ok: false, reason: "not_found" };
  return { ok: true, name };
}

export type LastfmTrack = {
  name: string;
  url: string;
  artist: string;
  artistUrl: string;
  imageUrl: string | null;
  nowPlaying: boolean;
};

type RecentTracksImage = { "#text"?: string; size?: string };
type RecentTracksTrack = {
  name?: string;
  url?: string;
  artist?: { "#text"?: string };
  image?: RecentTracksImage[];
  "@attr"?: { nowplaying?: string };
};
type RecentTracksBody = {
  recenttracks?: { track?: RecentTracksTrack | RecentTracksTrack[] };
};

function pickArtUrl(images: RecentTracksImage[] | undefined): string | null {
  if (!Array.isArray(images)) return null;
  const byLarge = images.find((img) => img.size === "extralarge") ?? images.find((img) => img.size === "large");
  const url = byLarge?.["#text"]?.trim();
  if (!url || url.includes(NO_ART_HASH)) return null;
  return url;
}

/** Pure parsing step, exported for unit testing without a network call. */
export function parseRecentTrack(body: unknown): LastfmTrack | null {
  const recent = (body as RecentTracksBody | undefined)?.recenttracks?.track;
  const raw = Array.isArray(recent) ? recent[0] : recent;
  if (!raw) return null;

  const name = raw.name?.trim();
  const url = raw.url?.trim();
  const artist = raw.artist?.["#text"]?.trim();
  if (!name || !url || !artist) return null;

  return {
    name,
    url,
    artist,
    artistUrl: `https://www.last.fm/music/${encodeURIComponent(artist)}`,
    imageUrl: pickArtUrl(raw.image),
    nowPlaying: raw["@attr"]?.nowplaying === "true",
  };
}

/** user.getrecenttracks&limit=1. Returns null when the account has never scrobbled. */
export async function getLastfmNowPlaying(username: string): Promise<LastfmTrack | null> {
  let body: RecentTracksBody;
  try {
    body = await callLastfm<RecentTracksBody>("user.getrecenttracks", { user: username, limit: "1" });
  } catch (error) {
    if (error instanceof LastfmError && error.message === "NOT_FOUND") {
      throw new LastfmError("That Last.fm account no longer exists.");
    }
    throw error;
  }
  return parseRecentTrack(body);
}
