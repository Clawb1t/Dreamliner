/**
 * YouTube on the feeds engine: one playlistItems call (1 quota unit) reads the newest five
 * uploads, shared by every server following the channel. Only uploads not stored yet are
 * classified (videos.list, 1 unit for all of them, plus the free Shorts URL check).
 */
import { YoutubeResolveError, fetchRecentUploads, fetchVideoDetails, probeShort, type VideoDetails } from "../../functions/youtube.js";
import { SHORTS_MAX_SECONDS, classifyUpload, uploadKindLabel } from "../../functions/logic.js";
import { FeedError, type FeedAdapter, type FeedItemInput } from "../types.js";
import { cleanTitle } from "../text.js";
import { configString } from "./http.js";

/** Uploads read per poll: enough that a burst of uploads between two polls is never missed. */
export const YOUTUBE_UPLOADS_PER_POLL = 5;

export const youtubeAdapter: FeedAdapter = {
  async fetch(source) {
    const playlistId = configString(source.config, "uploadsPlaylistId");
    if (!playlistId) throw new FeedError("This YouTube feed has no uploads playlist.", { permanent: true });
    try {
      const uploads = await fetchRecentUploads(playlistId, YOUTUBE_UPLOADS_PER_POLL);
      return {
        items: uploads.map(
          (upload): FeedItemInput => ({
            key: upload.videoId,
            title: cleanTitle(upload.title, "New video"),
            url: upload.url,
            imageUrl: upload.thumbnailUrl,
            summary: "",
            author: source.title || null,
            tags: [],
            publishedAt: upload.publishedAt,
            payload: { rawTitle: upload.title.slice(0, 300) },
          }),
        ),
      };
    } catch (error) {
      if (error instanceof YoutubeResolveError) throw new FeedError(error.message);
      throw error;
    }
  },

  async enrich(_source, items) {
    if (!items.length) return items;
    const details = await fetchVideoDetails(items.map((item) => item.key)).catch(() => new Map<string, VideoDetails>());
    return Promise.all(
      items.map(async (item) => {
        const info = details.get(item.key);
        if (!info) return { ...item, payload: { ...item.payload, kind: "video", typeLabel: "video" } };
        const maybeShort =
          info.liveBroadcastContent === "none" &&
          !info.hasLiveStreamingDetails &&
          info.durationSeconds !== null &&
          info.durationSeconds > 0 &&
          info.durationSeconds <= SHORTS_MAX_SECONDS;
        const kind = classifyUpload({
          liveBroadcastContent: info.liveBroadcastContent,
          hasLiveStreamingDetails: info.hasLiveStreamingDetails,
          durationSeconds: info.durationSeconds,
          shortsProbe: maybeShort ? await probeShort(item.key) : null,
        });
        return {
          ...item,
          imageUrl: info.thumbnailUrl || item.imageUrl,
          tags: [kind],
          payload: { ...item.payload, kind, typeLabel: uploadKindLabel(kind, info.liveBroadcastContent) },
        };
      }),
    );
  },
};
