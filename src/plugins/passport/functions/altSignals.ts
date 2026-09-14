import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { passportAltDismissals, passportNetworkSignals } from "../../../db/schema.js";
import { lookupGeo } from "./geoLookup.js";

export type PassportNetworkSignalRow = {
  guildId: string;
  userId: string;
  ipAddress: string;
  country: string | null;
  region: string | null;
  city: string | null;
  verifiedAt: Date;
};

/**
 * Record the network signal for a web Passport verification, for later alt-cluster matching.
 * Best-effort: a failed geo lookup still records the IP. Latest verification wins per member.
 */
export async function recordPassportNetworkSignal(
  guildId: string,
  userId: string,
  ip: string,
): Promise<void> {
  const geo = await lookupGeo(ip);
  const verifiedAt = new Date();
  await getDb()
    .insert(passportNetworkSignals)
    .values({
      guildId,
      userId,
      ipAddress: ip,
      country: geo.country,
      region: geo.region,
      city: geo.city,
      verifiedAt,
    })
    .onConflictDoUpdate({
      target: [passportNetworkSignals.guildId, passportNetworkSignals.userId],
      set: {
        ipAddress: ip,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        verifiedAt,
      },
    });
}

export async function listPassportNetworkSignals(
  guildId: string,
): Promise<PassportNetworkSignalRow[]> {
  return getDb()
    .select()
    .from(passportNetworkSignals)
    .where(eq(passportNetworkSignals.guildId, guildId))
    .all();
}

/** Delete-all control for a guild that turns Alt detection off. */
export async function deletePassportNetworkSignals(guildId: string): Promise<void> {
  await getDb().delete(passportNetworkSignals).where(eq(passportNetworkSignals.guildId, guildId));
}

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function dismissPassportAltPair(
  guildId: string,
  userIdA: string,
  userIdB: string,
  dismissedBy: string,
): Promise<void> {
  const [a, b] = sortPair(userIdA, userIdB);
  await getDb()
    .insert(passportAltDismissals)
    .values({ guildId, userIdA: a, userIdB: b, dismissedAt: new Date(), dismissedBy })
    .onConflictDoUpdate({
      target: [passportAltDismissals.guildId, passportAltDismissals.userIdA, passportAltDismissals.userIdB],
      set: { dismissedAt: new Date(), dismissedBy },
    });
}

export async function listPassportAltDismissals(
  guildId: string,
): Promise<{ userIdA: string; userIdB: string }[]> {
  return getDb()
    .select({
      userIdA: passportAltDismissals.userIdA,
      userIdB: passportAltDismissals.userIdB,
    })
    .from(passportAltDismissals)
    .where(eq(passportAltDismissals.guildId, guildId))
    .all();
}
