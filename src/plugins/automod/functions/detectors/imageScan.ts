import type { Attachment } from "discord.js";
import { fetchImageBuffer } from "../../../../core/imageFetch.js";
import { closestScamImageHash } from "../scamImageHashes.js";
import { computeDHash } from "../imageHash.js";
import { numSetting, type Detector } from "./types.js";
import { getLogger } from "../../../../core/logger.js";
const log = getLogger("automod");

const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

function looksLikeImage(attachment: Attachment): boolean {
  const type = attachment.contentType?.toLowerCase() ?? "";
  if (IMAGE_CONTENT_TYPES.some((t) => type.startsWith(t))) return true;
  // Discord doesn't always set content_type (older messages, some upload paths), so
  // fall back to the filename so those attachments aren't silently skipped entirely.
  const name = attachment.name?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function scannableAttachments(attachments: Iterable<Attachment>): Attachment[] {
  const out: Attachment[] = [];
  for (const attachment of attachments) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    if (!looksLikeImage(attachment)) continue;
    if (attachment.size > MAX_IMAGE_BYTES) continue;
    out.push(attachment);
  }
  return out;
}

/** Image Scanning: checks each image attachment's perceptual hash against the shared
 * (superuser-managed) scam-image blocklist. It's "is this the same picture as one we
 * already know about" rather than reading anything in it. Deliberately only looks at message
 * attachments, not link previews/embeds. Never throws: a fetch/decode failure just skips
 * that attachment, not the whole message check. */
export const detectImageScan: Detector = async (ctx, rule) => {
  if (ctx.kind !== "message") return null;
  const images = scannableAttachments(ctx.message.attachments.values());
  if (!images.length) return null;

  const maxDistance = Math.min(64, Math.max(0, numSetting(rule, "phash_max_distance", 5)));

  for (const attachment of images) {
    const buffer = await fetchImageBuffer(attachment.url);
    if (!buffer) {
      log.warn(`[automod] image_scan: could not fetch/read attachment "${attachment.name}", skipping it`);
      continue;
    }

    try {
      const phash = await computeDHash(buffer);
      const closest = await closestScamImageHash(phash);
      if (closest && closest.distance <= maxDistance) {
        return {
          ruleId: "image_scan",
          reason: "Known scam image",
          detail: closest.entry.label || `distance ${closest.distance}`,
        };
      }
      log.debug(
        `[automod] image_scan: hash ${phash}, threshold ${maxDistance}` +
          (closest ? `, closest blocklist entry "${closest.entry.label}" at distance ${closest.distance}` : ", blocklist is empty"),
      );
    } catch (error) {
      log.warn("[automod] image_scan: dHash failed for attachment:", error);
    }
  }

  return null;
};
