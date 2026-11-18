import { createHash } from "node:crypto";
import { SafeFetchError, safeFetch, type SafeFetchOptions, type SafeFetchResult } from "../../../../core/safeFetch.js";
import { FeedError, type FeedSourceRecord } from "../types.js";

export const FEED_ACCEPT_XML = ["xml", "rss", "atom", "rdf", "text/plain", "octet-stream"];
export const FEED_ACCEPT_JSON = ["json", "javascript", "text/plain"];

/** SafeFetchError -> FeedError with a message fit for the dashboard. */
export function toFeedError(error: unknown): FeedError {
  if (error instanceof FeedError) return error;
  if (error instanceof SafeFetchError) {
    const permanent =
      error.code === "invalid_url" ||
      error.code === "blocked_address" ||
      error.code === "bad_content_type" ||
      (error.code === "http" && (error.status === 404 || error.status === 410 || error.status === 401 || error.status === 403));
    const retryAfterS = error.retryAfterS ?? (error.status === 429 ? 600 : null);
    return new FeedError(error.message, { permanent, retryAfterS });
  }
  return new FeedError((error as Error)?.message?.slice(0, 200) || "The source couldn't be fetched.");
}

export function bodyHash(body: Buffer): string {
  return createHash("sha1").update(body).digest("hex");
}

/** Conditional GET for a source (ETag / Last-Modified), mapping failures to FeedError. */
export async function fetchSource(
  source: Pick<FeedSourceRecord, "etag" | "lastModified">,
  url: string,
  accept: string[],
  extra: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  try {
    return await safeFetch(url, { accept, etag: source.etag, lastModified: source.lastModified, ...extra });
  } catch (error) {
    throw toFeedError(error);
  }
}

/** GET + JSON.parse for JSON APIs (no conditional headers: these APIs rarely support them). */
export async function fetchJson<T>(url: string, extra: SafeFetchOptions = {}): Promise<{ data: T; result: SafeFetchResult }> {
  let result: SafeFetchResult;
  try {
    result = await safeFetch(url, { accept: FEED_ACCEPT_JSON, ...extra });
  } catch (error) {
    throw toFeedError(error);
  }
  try {
    return { data: JSON.parse(result.body.toString("utf8")) as T, result };
  } catch {
    throw new FeedError("The source didn't answer with JSON.");
  }
}

export function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
