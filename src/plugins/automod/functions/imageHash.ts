import { createCanvas, loadImage } from "@napi-rs/canvas";

/**
 * 64-bit difference hash (dHash), returned as 16 lowercase hex chars.
 *
 * dHash resizes the image to 9x8 grayscale pixels and records, for each row, whether
 * each pixel is brighter than the one to its right (64 bits total). It's not a
 * cryptographic hash. It's a *perceptual* one: near-identical images (recompressed,
 * lightly cropped/resized, re-watermarked) land on hashes a small Hamming distance
 * apart, which is exactly what "the same scam template reposted again" looks like.
 * No native deps beyond @napi-rs/canvas, already a project dependency.
 */
export async function computeDHash(buffer: Buffer): Promise<string> {
  const image = await loadImage(buffer);
  const width = 9;
  const height = 8;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
  }

  let bits = 0n;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 1; col++) {
      const left = gray[row * width + col]!;
      const right = gray[row * width + col + 1]!;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }

  return bits.toString(16).padStart(16, "0");
}

/** Hamming distance between two 64-bit hex hashes (0 = identical, 64 = maximally different). */
export function hammingDistance(a: string, b: string): number {
  const av = BigInt(`0x${a}`);
  const bv = BigInt(`0x${b}`);
  let x = av ^ bv;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function isValidPhash(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value);
}
