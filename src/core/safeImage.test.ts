import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { assertDecodableImage, imageDimensions, loadImageSafe, UnsafeImageError } from "./safeImage.js";

// The size that crashed the bot (Skia aborts the process when it can't allocate the bitmap).
const W = 34372;
const H = 19345;

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegHeader(width: number, height: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with the frame size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe("imageDimensions", () => {
  it("reads sizes from headers without decoding", () => {
    assert.deepEqual(imageDimensions(pngHeader(640, 480)), { width: 640, height: 480, format: "png" });
    assert.deepEqual(imageDimensions(jpegHeader(W, H)), { width: W, height: H, format: "jpeg" });
    assert.deepEqual(imageDimensions(gifHeader(64, 32)), { width: 64, height: 32, format: "gif" });
    assert.deepEqual(imageDimensions(webpVp8xHeader(1000, 2000)), { width: 1000, height: 2000, format: "webp" });
    assert.deepEqual(imageDimensions(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 48"></svg>')), {
      width: 24,
      height: 48,
      format: "svg",
    });
  });
});

describe("assertDecodableImage", () => {
  it("refuses images too big to decode, in every format", () => {
    for (const header of [pngHeader(W, H), jpegHeader(W, H), webpVp8xHeader(W, H), Buffer.from(`<svg width="${W}" height="${H}"></svg>`)]) {
      assert.throws(() => assertDecodableImage(header), UnsafeImageError);
    }
  });

  it("allows up to 5000px on a side and no more", () => {
    assert.doesNotThrow(() => assertDecodableImage(pngHeader(5000, 5000)));
    assert.throws(() => assertDecodableImage(pngHeader(5001, 100)), UnsafeImageError);
    assert.throws(() => assertDecodableImage(jpegHeader(100, 5001)), UnsafeImageError);
  });

  it("refuses formats it can't measure", () => {
    assert.throws(() => assertDecodableImage(Buffer.from("not an image at all")), UnsafeImageError);
  });

  it("accepts every image the bot ships with", () => {
    const roots = ["assets"].filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const images = roots.flatMap(walk).filter((path) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path));
    for (const path of images) assert.doesNotThrow(() => assertDecodableImage(readFileSync(path)), path);
  });
});

describe("loadImageSafe", () => {
  it("decodes normal images", async () => {
    const canvas = createCanvas(32, 16);
    canvas.getContext("2d").fillRect(0, 0, 32, 16);
    const image = await loadImageSafe(await canvas.encode("png"));
    assert.equal(image.width, 32);
    assert.equal(image.height, 16);
  });

  it("refuses private network URLs", async () => {
    await assert.rejects(loadImageSafe("http://127.0.0.1:4080/bridge/x.png"), UnsafeImageError);
    await assert.rejects(loadImageSafe("http://169.254.169.254/latest/meta-data"), UnsafeImageError);
    await assert.rejects(loadImageSafe("file:///etc/passwd"), UnsafeImageError);
  });
});
