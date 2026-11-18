/**
 * Rockstar Newswire (unofficial: Rockstar has no public feed). graph.rockstargames.com is an
 * Apollo server with automatic persisted queries over GET: we send our own small query's sha256
 * first, and when the server answers PersistedQueryNotFound we send the query text with it, which
 * registers it. This doesn't depend on Rockstar's own query hashes (which rotate with deploys).
 * `created` has no time zone, so items are dated by first-seen instead.
 */
import { createHash } from "node:crypto";
import { FeedError, type FeedAdapter, type FeedItemInput } from "../types.js";
import { cleanTitle, resolveUrl } from "../text.js";
import { fetchJson } from "./http.js";

export const ROCKSTAR_ENDPOINT = "https://graph.rockstargames.com/";
export const ROCKSTAR_SITE = "https://www.rockstargames.com";

export const ROCKSTAR_QUERY =
  "query DreamlinerNewswire($locale: String!, $page: Int!, $limit: Int, $tagId: Int) { posts(page: $page, tagId: $tagId, locale: $locale, limit: $limit) { results { id: id_hash url title created primary_tags { id name } preview_images_parsed { newswire_block { d16x9 } } } } }";
export const ROCKSTAR_QUERY_HASH = createHash("sha256").update(ROCKSTAR_QUERY).digest("hex");

/** Tag ids on the Newswire. Null = everything (Latest). */
export const ROCKSTAR_TAGS = {
  latest: null,
  gta6: 666,
  gtaOnline: 702,
  gta5: 591,
  rdr2: 716,
  redDeadOnline: 736,
} as const;

type RockstarPost = {
  id?: string;
  url?: string;
  title?: string;
  created?: string;
  primary_tags?: { id?: number; name?: string }[];
  preview_images_parsed?: { newswire_block?: { d16x9?: string | null } | null } | null;
};
export type RockstarResponse = {
  data?: { posts?: { results?: RockstarPost[] } | null } | null;
  errors?: { message?: string }[];
};

export function rockstarRequestUrl(tagId: number | null, withQuery: boolean): string {
  const params = new URLSearchParams({
    operationName: "DreamlinerNewswire",
    variables: JSON.stringify({ locale: "en_us", page: 1, limit: 10, tagId }),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: ROCKSTAR_QUERY_HASH } }),
  });
  if (withQuery) params.set("query", ROCKSTAR_QUERY);
  return `${ROCKSTAR_ENDPOINT}?${params.toString()}`;
}

export function isPersistedQueryMiss(data: RockstarResponse): boolean {
  return Boolean(data?.errors?.some((e) => /PersistedQueryNotFound/i.test(e.message ?? "")));
}

export function parseRockstar(data: RockstarResponse): FeedItemInput[] {
  const results = data?.data?.posts?.results;
  if (!Array.isArray(results)) {
    const message = data?.errors?.[0]?.message;
    throw new FeedError(message ? `Rockstar Newswire error: ${message.slice(0, 120)}` : "The Rockstar Newswire didn't answer as expected.");
  }
  return results
    .filter((post) => post.id)
    .map((post) => ({
      key: String(post.id),
      title: cleanTitle(post.title),
      url: resolveUrl(post.url, ROCKSTAR_SITE) ?? `${ROCKSTAR_SITE}/newswire`,
      imageUrl: resolveUrl(post.preview_images_parsed?.newswire_block?.d16x9 ?? null),
      summary: "",
      author: null,
      tags: (post.primary_tags ?? []).map((t) => t.name ?? "").filter(Boolean),
      publishedAt: null,
    }));
}

export const rockstarAdapter: FeedAdapter = {
  async fetch(source) {
    const raw = source.config.tagId;
    const tagId = typeof raw === "number" ? raw : null;
    let { data } = await fetchJson<RockstarResponse>(rockstarRequestUrl(tagId, false));
    if (isPersistedQueryMiss(data)) ({ data } = await fetchJson<RockstarResponse>(rockstarRequestUrl(tagId, true)));
    return { items: parseRockstar(data) };
  },
};
