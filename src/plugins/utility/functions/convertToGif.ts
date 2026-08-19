import { createCanvas, loadImage } from "@napi-rs/canvas";
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

  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
  const gifBuffer = await encodeRgbaAsGif(data, width, height);

  return new AttachmentBuilder(gifBuffer, { name: `converted-${index + 1}.gif` });
}

export { canvasToGif };
