import { isIP } from "node:net";
import { listPassportAltDismissals, listPassportNetworkSignals } from "./altSignals.js";
import type { PassportNetworkSignalRow } from "./altSignals.js";

export type AltConfidenceTier = "high" | "medium" | "low";
export type AltSignalType = "exact_ip" | "subnet" | "city_only";

export type AltCluster = {
  clusterId: string;
  confidenceTier: AltConfidenceTier;
  memberIds: string[];
  signalTypes: AltSignalType[];
  firstSeenAt: Date;
  lastSeenAt: Date;
};

const TIER_WEIGHT: Record<AltConfidenceTier, number> = { low: 1, medium: 2, high: 3 };

/** First 3 octets of an IPv4, or first 4 hextets of an IPv6 — a /24 or /48-ish grouping key. */
function subnetKey(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".");
    return parts.length === 4 ? `v4:${parts.slice(0, 3).join(".")}` : null;
  }
  if (version === 6) {
    // Not a fully RFC-correct expansion of shortened addresses, just a stable-enough prefix for
    // a fuzzy "same network" signal.
    const hextets = ip.split(":").slice(0, 4);
    return hextets.length > 0 ? `v6:${hextets.join(":")}` : null;
  }
  return null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) {
      this.parent.set(x, x);
      return x;
    }
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export type AltDismissalRow = { userIdA: string; userIdB: string };

/**
 * Pure clustering step, kept separate from the DB reads in `findLikelyAlts` so it can be unit
 * tested without a database. Never returns the underlying IP/city — only which accounts are
 * linked and how confident the match is.
 */
export function clusterAltSignals(
  rows: PassportNetworkSignalRow[],
  dismissals: AltDismissalRow[],
): AltCluster[] {
  const dismissed = new Set(dismissals.map((d) => pairKey(d.userIdA, d.userIdB)));
  const byUser = new Map<string, PassportNetworkSignalRow>();
  for (const row of rows) byUser.set(row.userId, row);

  const edges = new Map<string, { tier: AltConfidenceTier; types: Set<AltSignalType> }>();

  function addEdge(a: string, b: string, tier: AltConfidenceTier, type: AltSignalType) {
    if (a === b) return;
    const key = pairKey(a, b);
    if (dismissed.has(key)) return;
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, { tier, types: new Set([type]) });
      return;
    }
    existing.types.add(type);
    if (TIER_WEIGHT[tier] > TIER_WEIGHT[existing.tier]) existing.tier = tier;
  }

  function groupBy(keyFn: (row: PassportNetworkSignalRow) => string | null): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(row.userId);
      groups.set(key, group);
    }
    return groups;
  }

  const sameCity = (a: string, b: string) => {
    const ca = byUser.get(a)?.city;
    const cb = byUser.get(b)?.city;
    return Boolean(ca && cb && ca === cb);
  };

  // Exact IP — strongest signal.
  for (const [, userIds] of groupBy((row) => row.ipAddress)) {
    const distinct = [...new Set(userIds)];
    if (distinct.length < 2) continue;
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) addEdge(distinct[i], distinct[j], "high", "exact_ip");
    }
  }

  // Same subnet — medium, bumped to high if they also share a city.
  for (const [, userIds] of groupBy((row) => subnetKey(row.ipAddress))) {
    const distinct = [...new Set(userIds)];
    if (distinct.length < 2) continue;
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const [a, b] = [distinct[i], distinct[j]];
        addEdge(a, b, sameCity(a, b) ? "high" : "medium", "subnet");
      }
    }
  }

  // Same city only (different subnet) — weakest signal, geo-lookup dependent.
  for (const [, userIds] of groupBy((row) => row.city)) {
    const distinct = [...new Set(userIds)];
    if (distinct.length < 2) continue;
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) addEdge(distinct[i], distinct[j], "low", "city_only");
    }
  }

  if (edges.size === 0) return [];

  const uf = new UnionFind();
  for (const key of edges.keys()) {
    const [a, b] = key.split("|");
    uf.union(a, b);
  }

  const clusterMembers = new Map<string, Set<string>>();
  const clusterTier = new Map<string, AltConfidenceTier>();
  const clusterTypes = new Map<string, Set<AltSignalType>>();

  for (const [key, edge] of edges) {
    const [a, b] = key.split("|");
    const root = uf.find(a);
    const members = clusterMembers.get(root) ?? new Set<string>();
    members.add(a);
    members.add(b);
    clusterMembers.set(root, members);

    const tier = clusterTier.get(root);
    if (!tier || TIER_WEIGHT[edge.tier] > TIER_WEIGHT[tier]) clusterTier.set(root, edge.tier);

    const types = clusterTypes.get(root) ?? new Set<AltSignalType>();
    for (const t of edge.types) types.add(t);
    clusterTypes.set(root, types);
  }

  const clusters: AltCluster[] = [];
  for (const [root, members] of clusterMembers) {
    const memberIds = [...members];
    const timestamps = memberIds
      .map((id) => byUser.get(id)?.verifiedAt)
      .filter((d): d is Date => Boolean(d));
    clusters.push({
      clusterId: root,
      confidenceTier: clusterTier.get(root) ?? "low",
      memberIds,
      signalTypes: [...(clusterTypes.get(root) ?? [])],
      firstSeenAt: new Date(Math.min(...timestamps.map((d) => d.getTime()))),
      lastSeenAt: new Date(Math.max(...timestamps.map((d) => d.getTime()))),
    });
  }

  clusters.sort((a, b) => {
    const tierDiff = TIER_WEIGHT[b.confidenceTier] - TIER_WEIGHT[a.confidenceTier];
    return tierDiff !== 0 ? tierDiff : b.memberIds.length - a.memberIds.length;
  });

  return clusters;
}

/**
 * Groups likely-alt Discord accounts within a guild by network signals recorded at Passport web
 * verification.
 */
export async function findLikelyAlts(guildId: string): Promise<AltCluster[]> {
  const [rows, dismissals] = await Promise.all([
    listPassportNetworkSignals(guildId),
    listPassportAltDismissals(guildId),
  ]);
  return clusterAltSignals(rows, dismissals);
}
