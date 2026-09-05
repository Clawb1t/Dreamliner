/** Shared "download an image URL into a Buffer, safely" helper — used anywhere Dreamliner
 * needs to hash/inspect an image it doesn't host itself (Automod's Image Scanning, Impersonation
 * Detection's avatar hashing). Centralized so every caller gets the same size cap, timeout, and
 * User-Agent (Discord's CDN can 403 requests with no/unusual User-Agent). */
export async function fetchImageBuffer(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer | null> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DreamlinerBot/1.0; +https://www.dreamliner.site)" },
    });
    if (!res.ok) return null;
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) return null;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) return null;
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
