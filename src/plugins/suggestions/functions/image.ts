import type { Attachment, Client } from "discord.js";
import { resolveTextChannel } from "./embeds.js";
import type { Suggestion } from "./store.js";

/**
 * Images uploaded through the /suggest modal live as a file on the suggestion's own posts, stored
 * as `attachment://<name>`. Discord's links to uploaded files expire after about a day, but a
 * message's own attachments stay valid (and survive every edit), so the post references the file
 * by name and each new post (feed, denied, archive) gets its own copy.
 *
 * Suggestions from before uploads existed store a plain https:// URL and keep working as-is.
 */
export const ATTACHED_IMAGE_PREFIX = "attachment://";

/** Largest upload accepted: Discord's default bot upload limit. */
export const MAX_SUGGESTION_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** `attachment` is a link Discord downloads while sending, or the file bytes themselves. */
export type SuggestionImageFile = { attachment: string | Buffer; name: string };

export function isAttachedImage(url: string | null | undefined): url is string {
  return Boolean(url?.startsWith(ATTACHED_IMAGE_PREFIX));
}

/** Validates a modal upload and names it for posting, or explains why it can't be used. */
export function imageFromUpload(file: Attachment): { file: SuggestionImageFile } | { error: "type" | "size" } {
  const ext = IMAGE_TYPES[(file.contentType ?? "").split(";")[0]!.trim().toLowerCase()];
  if (!ext) return { error: "type" };
  if (file.size > MAX_SUGGESTION_IMAGE_BYTES) return { error: "size" };
  return { file: { attachment: file.url, name: `suggestion-image.${ext}` } };
}

/** The stored reference for a file posted as `name`. */
export function attachedImageRef(name: string): string {
  return `${ATTACHED_IMAGE_PREFIX}${name}`;
}

async function findPostedImage(client: Client, suggestion: Suggestion): Promise<Attachment | null> {
  if (!isAttachedImage(suggestion.attachmentUrl)) return null;
  const name = suggestion.attachmentUrl.slice(ATTACHED_IMAGE_PREFIX.length);
  const posts: Array<[string | null, string | null]> = [
    [suggestion.feedChannelId, suggestion.feedMessageId],
    [suggestion.reviewChannelId, suggestion.reviewMessageId],
  ];
  for (const [channelId, messageId] of posts) {
    if (!channelId || !messageId) continue;
    const channel = await resolveTextChannel(client, channelId);
    const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    const attachment = message?.attachments.find((a) => a.name === name);
    if (attachment) return attachment;
  }
  return null;
}

/** A copy of an uploaded suggestion image for a new post, downloaded from a post that already has
 *  it. Downloaded up front (not passed as a link) so it survives that post being deleted, as when a
 *  suggestion is denied. Null when there is no uploaded image or it can't be fetched. */
export async function copySuggestionImage(client: Client, suggestion: Suggestion): Promise<SuggestionImageFile | null> {
  const attachment = await findPostedImage(client, suggestion);
  if (!attachment) return null;
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return { attachment: Buffer.from(await res.arrayBuffer()), name: attachment.name };
  } catch {
    return null;
  }
}

/** A viewable link for places that show the image without posting a copy (like /suggestion info). */
export async function suggestionImageUrl(client: Client, suggestion: Suggestion): Promise<string | null> {
  if (!suggestion.attachmentUrl) return null;
  if (!isAttachedImage(suggestion.attachmentUrl)) return suggestion.attachmentUrl;
  return (await findPostedImage(client, suggestion))?.url ?? null;
}
