import type { FeedSourceType } from "../../../config/schemas/social.js";
export type { FeedSourceType };

/** One item as an adapter produced it, before it's stored. */
export type FeedItemInput = {
  /** Dedupe key, unique per source (guid, native id, normalised link, or a hash). */
  key: string;
  title: string;
  url: string;
  imageUrl: string | null;
  /** Plain-text excerpt, already stripped, escaped and shortened (~300 chars). */
  summary: string;
  author: string | null;
  tags: string[];
  /** Null when the source gives no usable time (first-seen is used instead). */
  publishedAt: Date | null;
  /** Type-specific extras (YouTube kind, Twitch game/viewers, Steam patch-notes flag...). */
  payload?: Record<string, unknown>;
};

/** What a source row looks like to an adapter. */
export type FeedSourceRecord = {
  id: number;
  type: FeedSourceType;
  key: string;
  config: Record<string, unknown>;
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
};

export type FeedFetchResult =
  | { notModified: true }
  | {
      notModified?: false;
      items: FeedItemInput[];
      /** Feed-level metadata, refreshed on the source row when present. */
      title?: string | null;
      iconUrl?: string | null;
      siteUrl?: string | null;
      etag?: string | null;
      lastModified?: string | null;
      /** Hash of the body: an unchanged body skips the item upsert entirely. */
      contentHash?: string | null;
    };

export type FeedAdapter = {
  /** Fetch the source's latest items (newest or oldest first, the engine sorts). */
  fetch(source: FeedSourceRecord): Promise<FeedFetchResult>;
  /** Called only with items not stored yet, before they're stored (e.g. YouTube type detection). */
  enrich?(source: FeedSourceRecord, items: FeedItemInput[]): Promise<FeedItemInput[]>;
};

/** A failure that should show on the dashboard as the source's error. */
export class FeedError extends Error {
  readonly retryAfterS: number | null;
  /** Permanent (404, not a feed): counts double toward auto-disable. */
  readonly permanent: boolean;
  constructor(message: string, options: { retryAfterS?: number | null; permanent?: boolean } = {}) {
    super(message);
    this.name = "FeedError";
    this.retryAfterS = options.retryAfterS ?? null;
    this.permanent = options.permanent ?? false;
  }
}
