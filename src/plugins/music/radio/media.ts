import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type http from "node:http";
import { getDashboardBridgePort } from "../../../bridge/env.js";
import { isRadioId, trackFilePath } from "./store.js";

/**
 * Lavalink plays radio MP3s over HTTP, so the bridge server serves them on one unauthenticated
 * route: GET /radio/media/<stationId>/<trackId>?exp=&sig=. The HMAC signature means only URLs the
 * bot handed out work. Range requests are supported so Lavalink can seek to the live offset.
 */

/** Long enough that a queued station entry is still playable after days in a 24/7 queue. */
const URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RADIO_MEDIA_PREFIX = "/radio/media/";

function secret(): string {
  const own = process.env.RADIO_MEDIA_SECRET?.trim();
  if (own) return own;
  const bridge = process.env.DASHBOARD_BRIDGE_SECRET?.trim();
  if (!bridge) throw new Error("Set RADIO_MEDIA_SECRET or DASHBOARD_BRIDGE_SECRET for radio media.");
  return createHmac("sha256", bridge).update("dreamliner-radio-media").digest("hex");
}

export function radioMediaBaseUrl(): string {
  const configured = process.env.RADIO_MEDIA_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || `http://127.0.0.1:${getDashboardBridgePort()}`;
}

export function signRadioPath(stationId: string, trackId: string, exp: number, key = secret()): string {
  return createHmac("sha256", key).update(`${stationId}/${trackId}/${exp}`).digest("hex").slice(0, 40);
}

export function signedRadioUrl(stationId: string, trackId: string, now = Date.now()): string {
  // Round the expiry to the hour so repeated resolves of one track give the same URL (and cache).
  const exp = Math.ceil((now + URL_TTL_MS) / 3_600_000) * 3_600_000;
  return `${radioMediaBaseUrl()}${RADIO_MEDIA_PREFIX}${stationId}/${trackId}?exp=${exp}&sig=${signRadioPath(stationId, trackId, exp)}`;
}

export type VerifiedMedia = { stationId: string; trackId: string } | null;

export function verifyRadioRequest(pathname: string, params: URLSearchParams, now = Date.now(), key?: string): VerifiedMedia {
  if (!pathname.startsWith(RADIO_MEDIA_PREFIX)) return null;
  const [stationId, trackId, ...rest] = pathname.slice(RADIO_MEDIA_PREFIX.length).split("/");
  if (rest.length || !stationId || !trackId || !isRadioId(stationId) || !isRadioId(trackId)) return null;
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  if (!Number.isFinite(exp) || exp < now || !/^[a-f0-9]{40}$/.test(sig)) return null;
  const expected = Buffer.from(signRadioPath(stationId, trackId, exp, key ?? secret()));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { stationId, trackId };
}

/** Parses a single "bytes=a-b" range. Null means "send the whole file"; false means unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

export function serveRadioMedia(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  let verified: VerifiedMedia = null;
  try {
    verified = verifyRadioRequest(url.pathname, url.searchParams);
  } catch {
    verified = null;
  }
  if (!verified) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }
  const path = trackFilePath(verified.stationId, verified.trackId);
  if (!existsSync(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  const size = statSync(path).size;
  const range = parseRange(req.headers.range, size);
  const headers = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (range === false) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "Content-Length": String(end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
