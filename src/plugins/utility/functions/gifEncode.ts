import { type Canvas } from "@napi-rs/canvas";
import { loadGifenc } from "./gifencLoader.js";

export async function encodeRgbaAsGif(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Buffer> {
  const { quantize, applyPalette, GIFEncoder } = await loadGifenc();
  const palette = quantize(data, 256);
  const indexData = applyPalette(data, palette);

  const gif = GIFEncoder();
  gif.writeFrame(indexData, width, height, { palette, delay: 0 });
  gif.finish();

  return Buffer.from(gif.bytes());
}

export async function canvasToGif(canvas: Canvas): Promise<Buffer> {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  return encodeRgbaAsGif(data, width, height);
}
