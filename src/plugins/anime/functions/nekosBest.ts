/** Thin client for the nekos.best image API (no key required). */

export class NekosBestError extends Error {}

export const NEKO_CATEGORY_URL = "https://nekos.best/api/v2/neko";

export type NekoResult = {
  /** Full CDN URL, e.g. https://nekos.best/api/v2/neko/<id>.png */
  url: string;
  artistName: string | null;
  artistHref: string | null;
};

type NekosBestApiResult = {
  url?: string;
  artist_name?: string;
  artist_href?: string;
};

// Nekos.best requires a real, honest User-Agent identifying the calling app — their docs
// are explicit that spoofed browser strings (e.g. "Mozilla/5.0 (compatible; ...)") get
// rejected rather than helping. Format is "APP_NAME (CONTACT_INFO)"; contact info can be
// an email, repo, or bot invite link.
const REQUEST_HEADERS = {
  "User-Agent": "DreamlinerBot/1.0 (+https://dreamliner.site)",
  Accept: "application/json",
};

export async function fetchRandomNeko(): Promise<NekoResult> {
  const res = await fetch(NEKO_CATEGORY_URL, { headers: REQUEST_HEADERS });
  if (!res.ok) {
    throw new NekosBestError(`Nekos.best API error (${res.status}).`);
  }
  const data = (await res.json()) as { results?: NekosBestApiResult[] };
  const result = data.results?.[0];
  if (!result?.url) {
    throw new NekosBestError("Nekos.best returned no image.");
  }
  return {
    url: result.url,
    artistName: result.artist_name?.trim() || null,
    artistHref: result.artist_href?.trim() || null,
  };
}

/** The `<id>.<ext>` tail of a nekos.best image URL — short enough to round-trip through a button customId. */
export function nekoUrlToRef(url: string): string {
  return url.split("/").pop() ?? url;
}

export function nekoRefToUrl(ref: string): string {
  return `${NEKO_CATEGORY_URL}/${ref}`;
}

export async function downloadNekoImage(url: string): Promise<{ buffer: Buffer; filename: string }> {
  const res = await fetch(url, { headers: { "User-Agent": REQUEST_HEADERS["User-Agent"] } });
  if (!res.ok) {
    throw new NekosBestError(`Failed to download image (${res.status}).`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const ext = url.split(".").pop()?.split(/[?#]/)[0]?.slice(0, 5) || "png";
  return { buffer: Buffer.from(arrayBuffer), filename: `neko.${ext}` };
}
