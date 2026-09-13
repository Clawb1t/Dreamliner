/**
 * Thin client for the Discofy Quotes API (native fetch, no dependency) — used by the
 * "Quote to Discofy" message context command to submit a quoted message to the public
 * Discofy feed. Requires DISCOFY_API_KEY.
 */

import { getLogger } from "../../../core/logger.js";

const log = getLogger("utility");

const API_URL = "https://discofy.net/api/quotes";
const MAX_CONTENT_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 80;
const MAX_ATTEMPTS = 3;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export class DiscofySubmitError extends Error {}

export type DiscofyQuotePayload = {
  content: string;
  quotedByDiscordId: string;
  quotedByUsername: string;
  quotedByAvatarUrl?: string;
  quoteeDiscordId: string;
  quoteeUsername: string;
  quoteeAvatarUrl?: string;
  mediaUrl?: string;
};

function apiKey(): string {
  const key = process.env.DISCOFY_API_KEY?.trim();
  if (!key) {
    throw new DiscofySubmitError("Discofy integration isn't configured on this bot yet (missing DISCOFY_API_KEY).");
  }
  return key;
}

function requireField(value: string | undefined, field: string, maxLength: number): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new DiscofySubmitError(`${field} is required.`);
  if (trimmed.length > maxLength) throw new DiscofySubmitError(`${field} must be ${maxLength} characters or fewer.`);
  return trimmed;
}

function optionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireDiscordId(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (!SNOWFLAKE_RE.test(trimmed)) {
    throw new DiscofySubmitError(`${field} must be a valid Discord user ID.`);
  }
  return trimmed;
}

/** Validates and trims a payload client-side so obviously-bad requests fail fast without a round trip. */
function normalizePayload(payload: DiscofyQuotePayload): DiscofyQuotePayload {
  return {
    content: requireField(payload.content, "content", MAX_CONTENT_LENGTH),
    quotedByDiscordId: requireDiscordId(payload.quotedByDiscordId, "quotedByDiscordId"),
    quotedByUsername: requireField(payload.quotedByUsername, "quotedByUsername", MAX_USERNAME_LENGTH),
    quotedByAvatarUrl: optionalUrl(payload.quotedByAvatarUrl),
    quoteeDiscordId: requireDiscordId(payload.quoteeDiscordId, "quoteeDiscordId"),
    quoteeUsername: requireField(payload.quoteeUsername, "quoteeUsername", MAX_USERNAME_LENGTH),
    quoteeAvatarUrl: optionalUrl(payload.quoteeAvatarUrl),
    mediaUrl: optionalUrl(payload.mediaUrl),
  };
}

type DiscofySuccessBody = { ok: true; url: string; quote: { url: string; [key: string]: unknown } };
type DiscofyErrorBody = { error?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submits a quote to Discofy and returns the public URL for the created quote.
 *
 * Retries on 429 (honoring `Retry-After`) and on 5xx/network errors with exponential backoff,
 * up to MAX_ATTEMPTS total tries. 400/401/403 are never retried — those mean the request or the
 * key itself needs fixing, not another attempt.
 */
export async function submitDiscofyQuote(payload: DiscofyQuotePayload): Promise<string> {
  const body = normalizePayload(payload);
  const key = apiKey();

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
      log.error(`Discofy submit network error (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new DiscofySubmitError("Could not reach Discofy after several attempts.");
    }

    if (res.ok) {
      const data = (await res.json()) as DiscofySuccessBody;
      const url = data.url ?? data.quote?.url;
      if (!url) throw new DiscofySubmitError("Discofy accepted the quote but returned no URL.");
      return url;
    }

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
      throw new DiscofySubmitError("Discofy is rate-limiting this bot right now — try again in a bit.");
    }

    if (res.status >= 500) {
      const errBody = (await res.json().catch(() => ({}))) as DiscofyErrorBody;
      lastError = errBody.error ?? `HTTP ${res.status}`;
      log.error(`Discofy server error (attempt ${attempt}/${MAX_ATTEMPTS}):`, res.status, errBody.error ?? "(no body)");
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      throw new DiscofySubmitError("Discofy is having issues right now — try again later.");
    }

    // 400/401/403 and anything else 4xx: not retryable, fix the request/key instead.
    const errBody = (await res.json().catch(() => ({}))) as DiscofyErrorBody;
    log.error(`Discofy rejected the request (${res.status}):`, errBody.error ?? "(no body)");
    if (res.status === 401 || res.status === 403) {
      throw new DiscofySubmitError("Discofy rejected the bot's API key (missing, invalid, or revoked).");
    }
    throw new DiscofySubmitError(errBody.error || `Discofy rejected the quote (HTTP ${res.status}).`);
  }

  throw new DiscofySubmitError(
    lastError instanceof Error ? lastError.message : "Could not submit the quote to Discofy.",
  );
}
