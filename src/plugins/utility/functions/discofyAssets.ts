/**
 * Thin client for the Discofy public content API (native fetch, no dependency) — used by
 * /discofy to pull a random or searched avatar/banner. Requires DISCOFY_API_KEY (the same key
 * used by the "Quote to Discofy" message context command).
 */

import { getLogger } from "../../../core/logger.js";
import type { Translator } from "../../../i18n/index.js";

const log = getLogger("utility");

const SITE_ORIGIN = "https://discofy.net";
const BASE_URL = `${SITE_ORIGIN}/api/v1`;
const MAX_ATTEMPTS = 3;

export class DiscofyAssetError extends Error {}

export type DiscofyAssetType = "AVATAR" | "BANNER";

export type DiscofyAsset = {
  id: string;
  fileUrl: string;
  type?: string;
  tag?: string;
  aesthetic?: string;
  mainColor?: string;
  animated?: boolean;
  [key: string]: unknown;
};

function apiKey(t: Translator): string {
  const key = process.env.DISCOFY_API_KEY?.trim();
  if (!key) {
    throw new DiscofyAssetError(
      t("utility.discofy.notConfigured", "Discofy integration isn't configured on this bot yet (missing DISCOFY_API_KEY)."),
    );
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DiscofyErrorBody = { error?: string };

/**
 * GETs a Discofy API path with the bot's key, retrying 429/5xx with backoff (honoring
 * `Retry-After`, in seconds) up to MAX_ATTEMPTS. 400/401/403 are never retried — those mean the
 * request or key itself needs fixing, not another attempt. A 404 resolves to `null` ("nothing
 * found"), not an error.
 */
async function discofyGet<T>(path: string, params: Record<string, string | undefined>, t: Translator): Promise<T | null> {
  const key = apiKey(t);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value) query.set(name, value);
  }
  const qs = query.toString();
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch (error) {
      lastError = error;
      log.error(`Discofy fetch network error (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new DiscofyAssetError(t("utility.discofy.unreachable", "Could not reach Discofy after several attempts."));
    }

    if (res.ok) {
      return (await res.json()) as T;
    }

    if (res.status === 404) return null;

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const errBody = (await res.json().catch(() => ({}))) as DiscofyErrorBody;
      log.error(`Discofy rate limited (attempt ${attempt}/${MAX_ATTEMPTS}):`, errBody.error ?? "(no body)");
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 2 ** attempt) * 1000;
        await sleep(waitMs);
        continue;
      }
      throw new DiscofyAssetError(t("utility.discofy.rateLimited", "Discofy is rate-limiting this bot right now — try again in a bit."));
    }

    if (res.status >= 500) {
      const errBody = (await res.json().catch(() => ({}))) as DiscofyErrorBody;
      lastError = errBody.error ?? `HTTP ${res.status}`;
      log.error(`Discofy server error (attempt ${attempt}/${MAX_ATTEMPTS}):`, res.status, errBody.error ?? "(no body)");
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new DiscofyAssetError(t("utility.discofy.serverError", "Discofy is having issues right now — try again later."));
    }

    // 400/401/403 and anything else 4xx: not retryable, fix the request/key instead.
    const errBody = (await res.json().catch(() => ({}))) as DiscofyErrorBody;
    log.error(`Discofy rejected the request (${res.status}):`, errBody.error ?? "(no body)");
    if (res.status === 401 || res.status === 403) {
      throw new DiscofyAssetError(t("utility.discofy.badApiKey", "Discofy rejected the bot's API key (missing, invalid, or revoked)."));
    }
    throw new DiscofyAssetError(
      errBody.error || t("utility.discofy.assetRequestRejected", "Discofy rejected the request (HTTP {status}).", { status: res.status }),
    );
  }

  throw new DiscofyAssetError(
    lastError instanceof Error ? lastError.message : t("utility.discofy.requestFailed", "Could not reach Discofy."),
  );
}

/** Discofy sometimes returns `fileUrl` as a site-relative path (e.g. `/uploads/banner/x.webp`)
 *  rather than an absolute URL — resolve it against the site origin so Discord's embed/button
 *  builders (which require an absolute URL) don't reject it. */
function resolveAssetUrl(asset: DiscofyAsset): DiscofyAsset {
  if (typeof asset.fileUrl === "string" && asset.fileUrl.startsWith("/")) {
    return { ...asset, fileUrl: `${SITE_ORIGIN}${asset.fileUrl}` };
  }
  return asset;
}

/** One uniformly-random avatar/banner matching `type`. Returns null if nothing matches (404). */
export async function getRandomDiscofyAsset(type: DiscofyAssetType, t: Translator): Promise<DiscofyAsset | null> {
  const result = await discofyGet<{ data: DiscofyAsset }>("/assets/random", { type }, t);
  return result?.data ? resolveAssetUrl(result.data) : null;
}

/** Top search match for `query` among assets of `type`. Returns null if nothing matches. */
export async function searchDiscofyAsset(type: DiscofyAssetType, query: string, t: Translator): Promise<DiscofyAsset | null> {
  const result = await discofyGet<{ assets: DiscofyAsset[] }>("/assets", { type, q: query, page: "1" }, t);
  return result?.assets?.[0] ? resolveAssetUrl(result.assets[0]) : null;
}
