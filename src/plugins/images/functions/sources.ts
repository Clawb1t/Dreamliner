import { escapeMarkdown } from "discord.js";
import type { ImageSource } from "../../../config/schemas/images.js";

const FETCH_TIMEOUT_MS = 8_000;

/** nekos.best's still-image (png) categories. Its other endpoints are reaction GIFs. */
const NEKOS_CATEGORIES = ["neko", "waifu", "kitsune", "husbando"] as const;

export type ImageResult = {
  url: string;
  /** Pre-built `-#` credit line content (masked markdown links, no `-# ` prefix). */
  credit: string;
};

export const IMAGE_SOURCE_LABELS: Record<ImageSource, string> = {
  anime: "Anime",
  blahaj: "Blåhaj",
  cat: "Cat",
  dog: "Dog",
  fox: "Fox",
  duck: "Duck",
  capybara: "Capybara",
  bird: "Bird",
};

const PHOTO_EMOJI = "<:icons_camera:1544417537180311684>";

export const IMAGE_SOURCE_EMOJIS: Record<ImageSource, string> = {
  anime: "<:icons_image:1544417559045079181>",
  blahaj: "<:BlahajReach:1552262018138906674>",
  cat: PHOTO_EMOJI,
  dog: PHOTO_EMOJI,
  fox: PHOTO_EMOJI,
  duck: PHOTO_EMOJI,
  capybara: PHOTO_EMOJI,
  bird: PHOTO_EMOJI,
};

/** https URL or null. Plain http is upgraded: random-d.uk and capy.lol hand out http links but serve the same files over https. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Masked-link label: markdown-escaped, with brackets removed so they can't break the `[label](url)` syntax. */
function linkLabel(text: string): string {
  return escapeMarkdown(text.replace(/[[\]]/g, "").trim()).slice(0, 80);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Dreamliner (https://dreamliner.site)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

async function fetchNekos(): Promise<ImageResult> {
  const category = NEKOS_CATEGORIES[Math.floor(Math.random() * NEKOS_CATEGORIES.length)];
  const body = (await getJson(`https://nekos.best/api/v2/${category}`)) as {
    results?: { url?: unknown; artist_name?: unknown; artist_href?: unknown; source_url?: unknown }[];
  };
  const result = body.results?.[0];
  const url = httpsUrl(result?.url);
  if (!result || !url) throw new Error("nekos.best returned no image");

  const parts: string[] = [];
  const artistName = typeof result.artist_name === "string" ? linkLabel(result.artist_name) : "";
  const artistHref = httpsUrl(result.artist_href);
  if (artistName) parts.push(artistHref ? `Art by [${artistName}](<${artistHref}>)` : `Art by ${artistName}`);
  const sourceUrl = httpsUrl(result.source_url);
  if (sourceUrl) parts.push(`[Source](<${sourceUrl}>)`);
  parts.push("via [nekos.best](<https://nekos.best>)");
  return { url, credit: parts.join(" · ") };
}

async function fetchBlahaj(): Promise<ImageResult> {
  const body = (await getJson("https://transgirl.wamellow.com/")) as { url?: unknown };
  const url = httpsUrl(body.url);
  if (!url) throw new Error("transgirl.wamellow.com returned no image");

  const parts = ["via [transgirl.wamellow.com](<https://transgirl.wamellow.com>)"];
  // Images are mirrored from Reddit and named after the post id, e.g. `reddit_1k27dfc.webp`.
  const redditId = /\/reddit_([a-z0-9]+)\.[a-z0-9]+$/i.exec(new URL(url).pathname)?.[1];
  if (redditId) parts.unshift(`[Original post](<https://redd.it/${redditId}>)`);
  return { url, credit: parts.join(" · ") };
}

async function fetchCat(): Promise<ImageResult> {
  const body = (await getJson("https://api.thecatapi.com/v1/images/search")) as { url?: unknown }[];
  const url = httpsUrl(body[0]?.url);
  if (!url) throw new Error("TheCatAPI returned no image");
  return { url, credit: "via [TheCatAPI](<https://thecatapi.com>)" };
}

/** `https://images.dog.ceo/breeds/hound-afghan/x.jpg` -> "Afghan Hound". */
function dogBreed(url: string): string | null {
  const slug = /\/breeds\/([a-z-]+)\//i.exec(new URL(url).pathname)?.[1];
  if (!slug) return null;
  return slug
    .split("-")
    .reverse()
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function fetchDog(): Promise<ImageResult> {
  const body = (await getJson("https://dog.ceo/api/breeds/image/random")) as { message?: unknown };
  const url = httpsUrl(body.message);
  if (!url) throw new Error("Dog CEO returned no image");
  const breed = dogBreed(url);
  const parts = ["via [Dog CEO](<https://dog.ceo/dog-api/>)"];
  if (breed) parts.unshift(linkLabel(breed));
  return { url, credit: parts.join(" · ") };
}

async function fetchFox(): Promise<ImageResult> {
  const body = (await getJson("https://randomfox.ca/floof/")) as { image?: unknown; link?: unknown };
  const url = httpsUrl(body.image);
  if (!url) throw new Error("RandomFox returned no image");
  const link = httpsUrl(body.link);
  const parts = ["via [RandomFox](<https://randomfox.ca>)"];
  if (link) parts.unshift(`[Permalink](<${link}>)`);
  return { url, credit: parts.join(" · ") };
}

async function fetchDuck(): Promise<ImageResult> {
  const body = (await getJson("https://random-d.uk/api/v2/random")) as { url?: unknown };
  const url = httpsUrl(body.url);
  if (!url) throw new Error("random-d.uk returned no image");
  return { url, credit: "via [random-d.uk](<https://random-d.uk>)" };
}

async function fetchCapybara(): Promise<ImageResult> {
  const body = (await getJson("https://api.capy.lol/v1/capybara?json=true")) as { data?: { url?: unknown } };
  const url = httpsUrl(body.data?.url);
  if (!url) throw new Error("capy.lol returned no image");
  return { url, credit: "via [capy.lol](<https://capy.lol>)" };
}

async function fetchBird(): Promise<ImageResult> {
  const body = (await getJson("https://api.alexflipnote.dev/birb")) as { file?: unknown };
  const url = httpsUrl(body.file);
  if (!url) throw new Error("AlexFlipnote returned no image");
  return { url, credit: "via [AlexFlipnote API](<https://api.alexflipnote.dev>)" };
}

const FETCHERS: Record<ImageSource, () => Promise<ImageResult>> = {
  anime: fetchNekos,
  blahaj: fetchBlahaj,
  cat: fetchCat,
  dog: fetchDog,
  fox: fetchFox,
  duck: fetchDuck,
  capybara: fetchCapybara,
  bird: fetchBird,
};

export function fetchImage(source: ImageSource): Promise<ImageResult> {
  return FETCHERS[source]();
}
