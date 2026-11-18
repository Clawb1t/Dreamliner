/** Per-subscription item filters. Pure: returns why an item is skipped, or null to post it. */
import type { FeedFilters, FeedSourceType, YoutubeUploadKind } from "../../../config/schemas/social.js";
import { uploadKindEnabled } from "../functions/logic.js";
import type { RenderItem } from "./render.js";

function haystack(item: Pick<RenderItem, "title" | "summary">): string {
  return `${item.title} ${item.summary}`.replace(/\\/g, "").toLowerCase();
}

export function filterReason(filters: FeedFilters, sourceType: FeedSourceType, item: Pick<RenderItem, "title" | "summary" | "tags" | "payload">): string | null {
  const text = haystack(item);
  if (filters.include_keywords.length && !filters.include_keywords.some((k) => text.includes(k.toLowerCase()))) {
    return "No include keyword matched";
  }
  const excluded = filters.exclude_keywords.find((k) => text.includes(k.toLowerCase()));
  if (excluded) return `Matched excluded keyword "${excluded}"`;
  if (filters.categories.length) {
    const tags = item.tags.map((t) => t.toLowerCase());
    if (!filters.categories.some((c) => tags.includes(c.toLowerCase()))) return "Not in a chosen category";
  }
  if (sourceType === "steam" && filters.steam_patch_notes_only && item.payload?.patchNotes !== true) return "Not patch notes";
  if (sourceType === "youtube") {
    const kind = (typeof item.payload?.kind === "string" ? item.payload.kind : "video") as YoutubeUploadKind;
    if (!uploadKindEnabled(filters, kind)) return kind === "short" ? "Shorts are off" : kind === "live" ? "Livestreams are off" : "Videos are off";
  }
  return null;
}
