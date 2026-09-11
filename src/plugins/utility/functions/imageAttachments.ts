import type { Attachment, Collection } from "discord.js";

export const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

export function isImageAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? "";
  if (contentType.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.test(attachment.name ?? attachment.url);
}

export function getImageAttachments(
  attachments: Collection<string, Attachment>,
): Attachment[] {
  return [...attachments.values()].filter(isImageAttachment);
}

export async function downloadUrl(url: string, maxBytes = MAX_IMAGE_DOWNLOAD_BYTES): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download (${res.status})`);
  }

  const lengthHeader = res.headers.get("content-length");
  if (lengthHeader && Number.parseInt(lengthHeader, 10) > maxBytes) {
    throw new Error("File is too large");
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error("File is too large");
  }

  return buffer;
}

export async function downloadAttachment(attachment: Attachment, maxBytes = MAX_IMAGE_DOWNLOAD_BYTES): Promise<Buffer> {
  try {
    return await downloadUrl(attachment.url, maxBytes);
  } catch {
    throw new Error("Failed to download attachment or it is too large");
  }
}
