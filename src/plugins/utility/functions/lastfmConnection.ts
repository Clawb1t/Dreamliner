import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { userLastfmConnections } from "../../../db/schema.js";

/**
 * A member's connected Last.fm username — global to their Discord account (set from the website
 * account page's Connections tab), not per-guild. Read by the "Listening to" user context command.
 */
export async function getLastfmUsername(userId: string): Promise<string | null> {
  const row = await getDb().select().from(userLastfmConnections).where(eq(userLastfmConnections.userId, userId)).get();
  return row?.username ?? null;
}

export async function setLastfmUsername(userId: string, username: string): Promise<void> {
  await getDb()
    .insert(userLastfmConnections)
    .values({ userId, username })
    .onConflictDoUpdate({
      target: [userLastfmConnections.userId],
      set: { username },
    });
}

export async function clearLastfmUsername(userId: string): Promise<void> {
  await getDb().delete(userLastfmConnections).where(eq(userLastfmConnections.userId, userId));
}
