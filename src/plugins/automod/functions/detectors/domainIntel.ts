import { getLogger } from "../../../../core/logger.js";
import { boolSetting, extractHosts, numSetting, stringListSetting, type Detector } from "./types.js";

const log = getLogger("automod");

/** Free, keyless malware/phishing feed (abuse.ch). No account, no API key, no rate-limit
 * headers to manage — see https://urlhaus-api.abuse.ch/. Used as an authoritative "this domain
 * is actively serving malware" signal on top of the heuristics below. */
const URLHAUS_HOST_ENDPOINT = "https://urlhaus-api.abuse.ch/v1/host/";
const URLHAUS_TIMEOUT_MS = 4_000;

/** TLDs that are free or near-free to register and disproportionately used for throwaway
 * phishing/scam domains. Not a ban list by itself — just one point of heuristic evidence. */
const RISKY_TLDS = new Set([
  "zip", "mov", "top", "xyz", "club", "work", "support", "rest", "click", "link", "sbs", "icu",
  "gq", "cf", "tk", "ml", "ga", "quest", "cam", "cyou", "bond", "beauty",
]);

/** Brand name -> the real domain(s) it's allowed to appear on. A link whose host contains one
 * of these keywords but doesn't actually belong to that brand is a classic phishing pattern
 * (e.g. "discord-nitro-gift.top" or "steamcommunity.com.verify-login.xyz"). */
const BRAND_HOMES: Record<string, string[]> = {
  discord: ["discord.com", "discordapp.com", "discord.gg", "discord.media"],
  steam: ["steamcommunity.com", "steampowered.com", "steamgames.com"],
  nitro: ["discord.com", "discordapp.com"],
  paypal: ["paypal.com", "paypal.me"],
  microsoft: ["microsoft.com", "live.com", "office.com"],
  roblox: ["roblox.com"],
  epicgames: ["epicgames.com"],
  riotgames: ["riotgames.com"],
  valorant: ["riotgames.com", "playvalorant.com"],
  binance: ["binance.com"],
  metamask: ["metamask.io"],
  coinbase: ["coinbase.com"],
};

export type DomainHeuristicResult = { score: number; reasons: string[] };

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function registrableSuffix(host: string, brandDomains: string[]): boolean {
  return brandDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Pure, network-free scoring so it's cheap to run on every link and unit-testable on its own.
 * Higher score = more suspicious; nothing here is fatal by itself, they add up. */
export function scoreDomainHeuristics(host: string): DomainHeuristicResult {
  const reasons: string[] = [];
  let score = 0;

  if (isIpLiteral(host)) {
    score += 4;
    reasons.push("raw IP address instead of a domain");
  }

  const labels = host.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) {
    score += 3;
    reasons.push("punycode / lookalike characters");
  }

  const tld = labels.at(-1) ?? "";
  if (RISKY_TLDS.has(tld)) {
    score += 2;
    reasons.push(`.${tld} domain`);
  }

  const hyphens = (host.match(/-/g) ?? []).length;
  if (hyphens >= 3) {
    score += 1;
    reasons.push("many hyphens");
  }

  if (labels.length >= 5) {
    score += 1;
    reasons.push("deeply nested subdomain");
  }

  for (const [brand, homes] of Object.entries(BRAND_HOMES)) {
    if (host.includes(brand) && !registrableSuffix(host, homes)) {
      score += 3;
      reasons.push(`impersonates "${brand}"`);
      break;
    }
  }

  return { score, reasons };
}

type UrlhausCacheEntry = { malicious: boolean; expiresAt: number };
const urlhausCache = new Map<string, UrlhausCacheEntry>();
const URLHAUS_CACHE_TTL_MS = 30 * 60_000;
const URLHAUS_CACHE_MAX_SIZE = 5_000;

/**
 * Asks abuse.ch's URLhaus whether this host is a known-active malware distribution point.
 * Fails open (returns false) on any network/parse error or timeout — a threat-feed outage
 * should never turn into false accusations or blocked legitimate links.
 */
export async function isKnownMaliciousHost(host: string): Promise<boolean> {
  const cached = urlhausCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.malicious;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URLHAUS_TIMEOUT_MS);
  let malicious = false;
  try {
    const res = await fetch(URLHAUS_HOST_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (compatible; DreamlinerBot/1.0; +https://www.dreamliner.site)",
      },
      body: `host=${encodeURIComponent(host)}`,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        query_status?: string;
        urls?: { url_status?: string }[];
      };
      malicious =
        data.query_status === "ok" && (data.urls ?? []).some((u) => u.url_status === "online");
    }
  } catch (error) {
    log.debug(`[automod] domain_intel: URLhaus lookup failed for "${host}", skipping:`, error);
  } finally {
    clearTimeout(timeout);
  }

  if (urlhausCache.size >= URLHAUS_CACHE_MAX_SIZE) urlhausCache.clear();
  urlhausCache.set(host, { malicious, expiresAt: Date.now() + URLHAUS_CACHE_TTL_MS });
  return malicious;
}

const MAX_HOSTS_PER_MESSAGE = 5;

/** Domain Intelligence: catches dangerous links Link Spam's static blocklist won't — a live
 * malware feed plus lookalike/IP-literal/brand-impersonation heuristics. Never throws: a feed
 * outage just falls back to heuristics-only for that message. */
export const detectDomainIntel: Detector = async (ctx, rule) => {
  if (ctx.kind !== "message" || !ctx.content) return null;
  const hosts = extractHosts(ctx.content).slice(0, MAX_HOSTS_PER_MESSAGE);
  if (!hosts.length) return null;

  const trusted = new Set(stringListSetting(rule, "trusted_domains").map((d) => d.toLowerCase()));
  const checkFeeds = boolSetting(rule, "check_feeds", true);
  const minScore = Math.max(1, Math.round(numSetting(rule, "min_score", 3)));

  for (const host of hosts) {
    if (trusted.has(host) || [...trusted].some((d) => host.endsWith(`.${d}`))) continue;

    if (checkFeeds && (await isKnownMaliciousHost(host))) {
      return { ruleId: "domain_intel", reason: "Known malicious domain", detail: host };
    }

    const { score, reasons } = scoreDomainHeuristics(host);
    if (score >= minScore) {
      return {
        ruleId: "domain_intel",
        reason: "Suspicious domain",
        detail: `${host} (${reasons.join(", ")})`,
      };
    }
  }

  return null;
};
