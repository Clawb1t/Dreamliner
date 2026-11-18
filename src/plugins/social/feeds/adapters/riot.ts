import { FeedError, type FeedAdapter, type FeedItemInput } from "../types.js";
import { cleanTitle, parseDate, summarize } from "../text.js";
import { configString, fetchJson } from "./http.js";

export const RIOT_GAMES = {
  lol: { name: "League of Legends", host: "lol.secure.dyn.riotcdn.net", page: "lol" },
  valorant: { name: "VALORANT", host: "valorant.secure.dyn.riotcdn.net", page: "valorant" },
} as const;
export type RiotGame = keyof typeof RIOT_GAMES;

export const RIOT_REGIONS: Record<RiotGame, { value: string; label: string }[]> = {
  lol: [
    { value: "na1", label: "North America" },
    { value: "euw1", label: "EU West" },
    { value: "eun1", label: "EU Nordic and East" },
    { value: "kr", label: "Korea" },
    { value: "jp1", label: "Japan" },
    { value: "br1", label: "Brazil" },
    { value: "la1", label: "Latin America North" },
    { value: "la2", label: "Latin America South" },
    { value: "oc1", label: "Oceania" },
    { value: "tr1", label: "Turkey" },
    { value: "ru", label: "Russia" },
    { value: "me1", label: "Middle East" },
    { value: "sg2", label: "Southeast Asia" },
    { value: "tw2", label: "Taiwan" },
    { value: "vn2", label: "Vietnam" },
  ],
  valorant: [
    { value: "na", label: "North America" },
    { value: "eu", label: "Europe" },
    { value: "ap", label: "Asia Pacific" },
    { value: "kr", label: "Korea" },
    { value: "br", label: "Brazil" },
    { value: "latam", label: "Latin America" },
  ],
};

type RiotText = { locale?: string; content?: string };
type RiotEntry = {
  id?: number | string;
  created_at?: string;
  updated_at?: string | null;
  titles?: RiotText[];
  updates?: { created_at?: string; updated_at?: string; translations?: RiotText[] }[];
  maintenance_status?: string | null;
  incident_severity?: string | null;
};
export type RiotStatusResponse = { id?: string; name?: string; incidents?: RiotEntry[]; maintenances?: RiotEntry[] };

function english(texts: RiotText[] | undefined): string {
  if (!Array.isArray(texts)) return "";
  return (texts.find((t) => t.locale === "en_US") ?? texts.find((t) => t.locale?.startsWith("en")) ?? texts[0])?.content ?? "";
}

export function riotStatusUrl(game: RiotGame, region: string): string {
  return `https://${RIOT_GAMES[game].host}/channels/public/x/status/${encodeURIComponent(region)}.json`;
}

/** Riot's public status site for the game and region. */
export function riotStatusPage(game: RiotGame, region: string): string {
  return `https://status.riotgames.com/${RIOT_GAMES[game].page}?region=${encodeURIComponent(region)}&locale=en_US`;
}

/** Incidents and maintenances; every update to one is a new item (dedupe on id + updated_at). */
export function parseRiotStatus(data: RiotStatusResponse, game: RiotGame, region: string): FeedItemInput[] {
  if (!data || (!Array.isArray(data.incidents) && !Array.isArray(data.maintenances))) {
    throw new FeedError("Riot's status service didn't answer as expected.");
  }
  const out: FeedItemInput[] = [];
  const add = (entry: RiotEntry, kind: "incident" | "maintenance") => {
    if (entry.id === undefined || entry.id === null) return;
    const latest = [...(entry.updates ?? [])].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0];
    const changed = entry.updated_at ?? latest?.updated_at ?? latest?.created_at ?? entry.created_at ?? "";
    const severity = kind === "maintenance" ? (entry.maintenance_status ?? "scheduled") : (entry.incident_severity ?? "info");
    out.push({
      key: `${kind}:${entry.id}:${changed}`,
      title: cleanTitle(english(entry.titles), kind === "maintenance" ? "Scheduled maintenance" : "Service incident"),
      url: riotStatusPage(game, region),
      imageUrl: null,
      summary: summarize(english(latest?.translations)),
      author: null,
      tags: [kind, severity].filter(Boolean),
      publishedAt: parseDate(changed) ?? parseDate(entry.created_at),
      payload: { kind, severity, id: entry.id },
    });
  };
  for (const entry of data.incidents ?? []) add(entry, "incident");
  for (const entry of data.maintenances ?? []) add(entry, "maintenance");
  return out;
}

export const riotStatusAdapter: FeedAdapter = {
  async fetch(source) {
    const game = configString(source.config, "game") as RiotGame;
    const region = configString(source.config, "region");
    if (!(game in RIOT_GAMES) || !RIOT_REGIONS[game].some((r) => r.value === region)) {
      throw new FeedError("Unknown Riot game or region.", { permanent: true });
    }
    const { data } = await fetchJson<RiotStatusResponse>(riotStatusUrl(game, region));
    return { items: parseRiotStatus(data, game, region) };
  },
};
