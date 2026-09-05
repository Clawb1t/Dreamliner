import {
  addScamImageHash,
  addScamImageHashFromBuffer,
  listScamImageHashes,
  rankScamImageHashDistances,
  removeScamImageHash,
  ScamImageHashError,
  type ScamImageHashEntry,
  type ScamImageHashMatch,
} from "../plugins/automod/functions/scamImageHashes.js";
import { computeDHash } from "../plugins/automod/functions/imageHash.js";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function decodeImageBase64(input: string): Buffer {
  const cleaned = input.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  const buffer = Buffer.from(cleaned, "base64");
  if (!buffer.length) throw new ScamImageHashError("Empty image data.");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ScamImageHashError("Image is too large (max 8MB).");
  return buffer;
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScamImageHashError("Not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScamImageHashError("Only http(s) image URLs are supported.");
  }
  const res = await fetch(parsed, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res || !res.ok) throw new ScamImageHashError("Could not download that URL.");
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new ScamImageHashError("That URL is not an image.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) throw new ScamImageHashError("Image is too large (max 8MB).");
  return buf;
}

/** Resolves an image source (upload or URL) to a buffer. Shared by add and test. */
async function resolveImageBuffer(input: { imageBase64?: string; imageUrl?: string }): Promise<Buffer> {
  if (input.imageBase64) return decodeImageBase64(input.imageBase64);
  if (input.imageUrl) return fetchImageBuffer(input.imageUrl);
  throw new ScamImageHashError("Provide an image upload or an image URL.");
}

export async function listWebScamImageHashes(): Promise<ScamImageHashEntry[]> {
  return listScamImageHashes();
}

export async function addWebScamImageHash(input: {
  userId: string;
  label: string;
  imageBase64?: string;
  imageUrl?: string;
  phash?: string;
}): Promise<ScamImageHashEntry> {
  if (input.phash) {
    return addScamImageHash(input.phash, input.label, input.userId);
  }
  const buffer = await resolveImageBuffer(input);
  return addScamImageHashFromBuffer(buffer, input.label, input.userId);
}

export async function removeWebScamImageHash(id: string): Promise<boolean> {
  return removeScamImageHash(id);
}

export type ScamImageHashTestResult = { phash: string; matches: ScamImageHashMatch[] };

/** Non-mutating: computes the hash for a test image and shows how close it is to every
 * blocklist entry, closest first. Lets a superuser sanity-check the whole pipeline
 * (upload/URL fetch, decode, hash, compare) without needing to post in a real Discord
 * channel and dig through bot logs to see what happened. */
export async function testWebScamImageHash(input: {
  imageBase64?: string;
  imageUrl?: string;
}): Promise<ScamImageHashTestResult> {
  const buffer = await resolveImageBuffer(input);
  let phash: string;
  try {
    phash = await computeDHash(buffer);
  } catch {
    throw new ScamImageHashError("Could not read that as an image.");
  }
  const matches = await rankScamImageHashDistances(phash);
  return { phash, matches };
}

export { ScamImageHashError };
