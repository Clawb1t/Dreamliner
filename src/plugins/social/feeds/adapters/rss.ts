import { parseFeed, FeedParseError } from "../parser.js";
import { FeedError, type FeedAdapter, type FeedSourceRecord } from "../types.js";
import { FEED_ACCEPT_XML, bodyHash, configString, fetchSource } from "./http.js";

/** The feed URL a source polls: RSS/status sources store it, GitHub builds it from owner/repo. */
export function feedUrlOf(source: Pick<FeedSourceRecord, "type" | "config">): string {
  if (source.type === "github") {
    const owner = configString(source.config, "owner");
    const repo = configString(source.config, "repo");
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases.atom`;
  }
  return configString(source.config, "url");
}

/** Any RSS 2.0 / Atom / RDF feed: custom RSS, GitHub releases, Statuspage history, RSS newswires. */
export const rssAdapter: FeedAdapter = {
  async fetch(source) {
    const url = feedUrlOf(source);
    if (!url) throw new FeedError("This feed has no URL.", { permanent: true });
    const result = await fetchSource(source, url, FEED_ACCEPT_XML);
    if (result.notModified) return { notModified: true };
    const contentHash = bodyHash(result.body);
    try {
      const feed = parseFeed(result.body, result.url, result.contentType);
      return {
        items: feed.items,
        title: feed.title || null,
        siteUrl: feed.siteUrl,
        iconUrl: feed.iconUrl,
        etag: result.etag,
        lastModified: result.lastModified,
        contentHash,
      };
    } catch (error) {
      if (error instanceof FeedParseError) throw new FeedError(error.message, { permanent: true });
      throw error;
    }
  },
};
