import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { usernameSnapshots } from "../../../db/schema.js";

export async function saveUsernameSnapshot(userId: string, username: string): Promise<void> {
  const db = getDb();
  await db
    .insert(usernameSnapshots)
    .values({ userId, username, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: usernameSnapshots.userId,
      set: { username, updatedAt: new Date() },
    });
}

export async function getUsernameSnapshot(userId: string): Promise<string | null> {
  const db = getDb();
  const row = await db.select().from(usernameSnapshots).where(eq(usernameSnapshots.userId, userId)).get();
  return row?.username ?? null;
}
