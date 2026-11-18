/**
 * Official game JSON feeds: Mojang's launcher content (Java/Bedrock patch notes, Minecraft news),
 * Fortnite Battle Royale news (fortnite-api.com, mirrors Epic's in-game MOTDs), HoYoverse news
 * (Genshin Impact, Honkai: Star Rail) and the Epic Games Store free games of the week.
 */
import { FeedError, type FeedAdapter, type FeedItemInput } from "../types.js";
import { cleanTitle, parseDate, resolveUrl, summarize } from "../text.js";
import { configString, fetchJson } from "./http.js";

// ---------------------------------------------------------------------------------------------
// Mojang
// ---------------------------------------------------------------------------------------------

export const MOJANG_BASE = "https://launchercontent.mojang.com";
export const MOJANG_FEEDS = {
  java: { path: "/v2/javaPatchNotes.json", link: "https://www.minecraft.net/en-us/updates" },
  bedrock: { path: "/v2/bedrockPatchNotes.json", link: "https://www.minecraft.net/en-us/updates" },
  news: { path: "/v2/news.json", link: "https://www.minecraft.net/en-us/article" },
} as const;
export type MojangFeed = keyof typeof MOJANG_FEEDS;

type MojangEntry = {
  id?: string;
  title?: string;
  version?: string;
  type?: string;
  patchNoteType?: string;
  date?: string;
  shortText?: string;
  text?: string;
  category?: string;
  image?: { url?: string };
  newsPageImage?: { url?: string };
  playPageImage?: { url?: string };
  readMoreLink?: string;
};
export type MojangResponse = { entries?: MojangEntry[] };

export function parseMojang(data: MojangResponse, feed: MojangFeed): FeedItemInput[] {
  if (!Array.isArray(data?.entries)) throw new FeedError("Mojang's launcher feed didn't answer as expected.");
  return data.entries
    .filter((entry) => entry.id || entry.title)
    .slice(0, 20)
    .map((entry) => {
      const image = entry.newsPageImage?.url ?? entry.image?.url ?? entry.playPageImage?.url ?? null;
      const kind = entry.type ?? entry.patchNoteType ?? entry.category ?? "";
      return {
        key: entry.id ?? `${entry.title}:${entry.date}`,
        title: cleanTitle(entry.title),
        url: resolveUrl(entry.readMoreLink) ?? MOJANG_FEEDS[feed].link,
        imageUrl: resolveUrl(image, MOJANG_BASE),
        summary: summarize(entry.shortText ?? entry.text ?? ""),
        author: null,
        tags: [kind, entry.version ? `v${entry.version}` : ""].filter(Boolean),
        publishedAt: parseDate(entry.date),
        payload: { version: entry.version ?? null, type: kind },
      };
    });
}

export const mojangAdapter: FeedAdapter = {
  async fetch(source) {
    const feed = configString(source.config, "feed") as MojangFeed;
    if (!(feed in MOJANG_FEEDS)) throw new FeedError("Unknown Minecraft feed.", { permanent: true });
    const { data } = await fetchJson<MojangResponse>(`${MOJANG_BASE}${MOJANG_FEEDS[feed].path}`);
    return { items: parseMojang(data, feed) };
  },
};

// ---------------------------------------------------------------------------------------------
// Fortnite
// ---------------------------------------------------------------------------------------------

type FortniteMotd = { id?: string; title?: string; tabTitle?: string; body?: string; image?: string; tileImage?: string; hidden?: boolean };
export type FortniteResponse = { status?: number; data?: { date?: string; motds?: FortniteMotd[] | null } | null };

export function parseFortnite(data: FortniteResponse): FeedItemInput[] {
  const motds = data?.data?.motds;
  if (!Array.isArray(motds)) throw new FeedError("Fortnite news didn't answer as expected.");
  return motds
    .filter((motd) => motd.id && !motd.hidden)
    .map((motd) => ({
      key: String(motd.id),
      title: cleanTitle(motd.title ?? motd.tabTitle),
      url: "https://www.fortnite.com/news",
      imageUrl: resolveUrl(motd.image ?? motd.tileImage ?? null),
      summary: summarize(motd.body ?? ""),
      author: null,
      tags: [],
      publishedAt: null,
    }));
}

export const fortniteAdapter: FeedAdapter = {
  async fetch() {
    const key = process.env.FORTNITE_API_KEY?.trim();
    const { data } = await fetchJson<FortniteResponse>("https://fortnite-api.com/v2/news/br", key ? { headers: { authorization: key } } : {});
    return { items: parseFortnite(data) };
  },
};

// ---------------------------------------------------------------------------------------------
// HoYoverse
// ---------------------------------------------------------------------------------------------

export const HOYO_GAMES = {
  genshin: {
    url: "https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc/getContentList?iAppId=32&iChanId=395&iPageSize=10&iPage=1&sLangKey=en-us",
    link: (id: string) => `https://genshin.hoyoverse.com/en/news/detail/${id}`,
    offset: "+08:00",
  },
  hsr: {
    url: "https://sg-public-api-static.hoyoverse.com/content_v2_user/app/113fe6d3b4514cdd/getContentList?iAppId=35&iChanId=248&iPageSize=10&iPage=1&sLangKey=en-us",
    link: (id: string) => `https://hsr.hoyoverse.com/en-us/news/${id}`,
    offset: "+08:00",
  },
} as const;
export type HoyoGame = keyof typeof HOYO_GAMES;

type HoyoEntry = { iInfoId?: number | string; sTitle?: string; sIntro?: string; dtStartTime?: string; sExt?: string; sCategoryName?: string };
export type HoyoResponse = { retcode?: number; message?: string; data?: { list?: HoyoEntry[] } | null };

function hoyoBanner(ext: string | undefined): string | null {
  if (!ext) return null;
  try {
    const parsed = JSON.parse(ext) as Record<string, unknown>;
    for (const key of ["banner", "news-poster", "720_1", "poster"]) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        const url = (list[0] as { url?: string } | undefined)?.url;
        if (url) return resolveUrl(url);
      }
    }
  } catch {
    /* no banner */
  }
  return null;
}

export function parseHoyo(data: HoyoResponse, game: HoyoGame): FeedItemInput[] {
  const list = data?.data?.list;
  if (data?.retcode !== 0 || !Array.isArray(list)) throw new FeedError("HoYoverse news didn't answer as expected.");
  const info = HOYO_GAMES[game];
  return list
    .filter((entry) => entry.iInfoId !== undefined)
    .map((entry) => {
      const id = String(entry.iInfoId);
      // "2026-11-16 11:00:00" is server time (UTC+8).
      const start = entry.dtStartTime ? `${entry.dtStartTime.replace(" ", "T")}${info.offset}` : null;
      return {
        key: id,
        title: cleanTitle(entry.sTitle),
        url: info.link(id),
        imageUrl: hoyoBanner(entry.sExt),
        summary: summarize(entry.sIntro ?? ""),
        author: null,
        tags: entry.sCategoryName ? [entry.sCategoryName] : [],
        publishedAt: parseDate(start),
      };
    });
}

export const hoyoverseAdapter: FeedAdapter = {
  async fetch(source) {
    const game = configString(source.config, "game") as HoyoGame;
    if (!(game in HOYO_GAMES)) throw new FeedError("Unknown HoYoverse game.", { permanent: true });
    const { data } = await fetchJson<HoyoResponse>(HOYO_GAMES[game].url);
    return { items: parseHoyo(data, game) };
  },
};

// ---------------------------------------------------------------------------------------------
// Epic Games Store: free games of the week
// ---------------------------------------------------------------------------------------------

type EpicOffer = { startDate?: string; endDate?: string; discountSetting?: { discountPercentage?: number } };
type EpicElement = {
  id?: string;
  title?: string;
  description?: string;
  productSlug?: string | null;
  urlSlug?: string | null;
  offerMappings?: { pageSlug?: string; pageType?: string }[] | null;
  catalogNs?: { mappings?: { pageSlug?: string; pageType?: string }[] | null } | null;
  keyImages?: { type?: string; url?: string }[];
  seller?: { name?: string } | null;
  promotions?: { promotionalOffers?: { promotionalOffers?: EpicOffer[] }[] } | null;
};
export type EpicFreeResponse = { data?: { Catalog?: { searchStore?: { elements?: EpicElement[] } } } };

function epicSlug(element: EpicElement): string | null {
  const mapping = [...(element.offerMappings ?? []), ...(element.catalogNs?.mappings ?? [])].find((m) => m.pageSlug && m.pageType !== "offer");
  const slug = mapping?.pageSlug ?? element.productSlug?.replace(/\/home$/, "") ?? null;
  return slug && slug !== "[]" ? slug : null;
}

/** Games free right now (an active promotional offer at 0%), deduped on game id + start date. */
export function parseEpicFree(data: EpicFreeResponse, now: Date = new Date()): FeedItemInput[] {
  const elements = data?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new FeedError("The Epic Games Store didn't answer as expected.");
  const out: FeedItemInput[] = [];
  for (const element of elements) {
    for (const group of element.promotions?.promotionalOffers ?? []) {
      for (const offer of group.promotionalOffers ?? []) {
        if (offer.discountSetting?.discountPercentage !== 0) continue;
        const start = parseDate(offer.startDate);
        const end = offer.endDate ? new Date(offer.endDate) : null;
        if (start && start.getTime() > now.getTime()) continue;
        if (end && end.getTime() <= now.getTime()) continue;
        const slug = epicSlug(element);
        const image =
          element.keyImages?.find((img) => img.type === "OfferImageWide")?.url ??
          element.keyImages?.find((img) => img.type === "DieselStoreFrontWide")?.url ??
          element.keyImages?.[0]?.url ??
          null;
        out.push({
          key: `${element.id}:${offer.startDate ?? ""}`,
          title: cleanTitle(element.title),
          url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : "https://store.epicgames.com/en-US/free-games",
          imageUrl: resolveUrl(image),
          summary: summarize(
            end ? `Free until ${end.toUTCString().replace(/:\d\d GMT$/, " UTC")}.` : "Free to claim now.",
          ),
          author: element.seller?.name ?? null,
          tags: ["free"],
          publishedAt: start,
          payload: { endsAt: end ? end.getTime() : null },
        });
      }
    }
  }
  return out;
}

export const epicFreeAdapter: FeedAdapter = {
  async fetch() {
    const { data } = await fetchJson<EpicFreeResponse>(
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US",
    );
    return { items: parseEpicFree(data) };
  },
};
