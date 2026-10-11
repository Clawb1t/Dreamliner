import { loadImageSafe } from "../../../core/safeImage.js";
import { createCanvas } from "@napi-rs/canvas";
import { AttachmentBuilder, type Attachment } from "discord.js";
import { canvasToGif, encodeRgbaAsGif } from "./gifEncode.js";
import { downloadAttachment } from "./imageAttachments.js";

function isGifAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? "";
  return contentType === "image/gif" || /\.gif$/i.test(attachment.name ?? attachment.url);
}

export async function convertAttachmentToGif(attachment: Attachment, index: number): Promise<AttachmentBuilder> {
  const buffer = await downloadAttachment(attachment);

  if (isGifAttachment(attachment)) {
    return new AttachmentBuilder(buffer, { name: `converted-${index + 1}.gif` });
  }

  const image = await loadImageSafe(buffer);
  // GIF encoding holds every pixel in memory several times over, so big images are scaled down.
  const MAX_GIF_SIDE = 2048;
  const scale = Math.min(1, MAX_GIF_SIDE / Math.max(image.width, image.height));
  const outW = Math.max(1, Math.round(image.width * scale));
  const outH = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, outW, outH);

  const { data, width, height } = ctx.getImageData(0, 0, outW, outH);
  const gifBuffer = await encodeRgbaAsGif(data, width, height);

  return new AttachmentBuilder(gifBuffer, { name: `converted-${index + 1}.gif` });
}

export { canvasToGif };
