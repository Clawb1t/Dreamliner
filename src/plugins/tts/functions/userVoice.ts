import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { ttsUserVoices } from "../../../db/schema.js";

/**
 * A member's personal voice preference — global to their Discord account (set with `/tts voice`
 * or from the website account page), not per-guild. Falls back to the guild default when unset.
 */
export async function getUserVoice(userId: string): Promise<string | null> {
  const row = await getDb().select().from(ttsUserVoices).where(eq(ttsUserVoices.userId, userId)).get();
  return row?.voice ?? null;
}

export async function setUserVoice(userId: string, voice: string): Promise<void> {
  await getDb()
    .insert(ttsUserVoices)
    .values({ userId, voice })
    .onConflictDoUpdate({
      target: [ttsUserVoices.userId],
      set: { voice },
    });
}

export async function clearUserVoice(userId: string): Promise<void> {
  await getDb().delete(ttsUserVoices).where(eq(ttsUserVoices.userId, userId));
}
