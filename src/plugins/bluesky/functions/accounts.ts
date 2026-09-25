import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { blueskyAccounts, blueskyActions } from "../../../db/schema.js";

export type BlueskyAccountRow = typeof blueskyAccounts.$inferSelect;
export type BlueskyActionKind = "like" | "repost" | "follow";

export async function getAccount(discordUserId: string): Promise<BlueskyAccountRow | null> {
  return (await getDb().select().from(blueskyAccounts).where(eq(blueskyAccounts.discordUserId, discordUserId)).get()) ?? null;
}

/** Other Discord users linked to the same Bluesky DID (one Bluesky account can only be linked once). */
export async function getAccountByDid(did: string): Promise<BlueskyAccountRow | null> {
  return (await getDb().select().from(blueskyAccounts).where(eq(blueskyAccounts.did, did)).get()) ?? null;
}

export async function upsertAccount(input: {
  discordUserId: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}): Promise<BlueskyAccountRow> {
  const now = new Date();
  return getDb()
    .insert(blueskyAccounts)
    .values({ ...input, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: blueskyAccounts.discordUserId,
      set: { did: input.did, handle: input.handle, displayName: input.displayName, avatarUrl: input.avatarUrl, updatedAt: now },
    })
    .returning()
    .get();
}

/** Removes the link and every undo record for it. */
export async function deleteAccount(discordUserId: string): Promise<void> {
  const db = getDb();
  await db.delete(blueskyActions).where(eq(blueskyActions.discordUserId, discordUserId)).run();
  await db.delete(blueskyAccounts).where(eq(blueskyAccounts.discordUserId, discordUserId)).run();
}

export async function getAction(
  discordUserId: string,
  subjectUri: string,
  kind: BlueskyActionKind,
): Promise<string | null> {
  const row = await getDb()
    .select({ recordUri: blueskyActions.recordUri })
    .from(blueskyActions)
    .where(
      and(
        eq(blueskyActions.discordUserId, discordUserId),
        eq(blueskyActions.subjectUri, subjectUri),
        eq(blueskyActions.kind, kind),
      ),
    )
    .get();
  return row?.recordUri ?? null;
}

export async function saveAction(
  discordUserId: string,
  subjectUri: string,
  kind: BlueskyActionKind,
  recordUri: string,
): Promise<void> {
  await getDb()
    .insert(blueskyActions)
    .values({ discordUserId, subjectUri, kind, recordUri, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [blueskyActions.discordUserId, blueskyActions.subjectUri, blueskyActions.kind],
      set: { recordUri, createdAt: new Date() },
    })
    .run();
}

export async function deleteAction(discordUserId: string, subjectUri: string, kind: BlueskyActionKind): Promise<void> {
  await getDb()
    .delete(blueskyActions)
    .where(
      and(
        eq(blueskyActions.discordUserId, discordUserId),
        eq(blueskyActions.subjectUri, subjectUri),
        eq(blueskyActions.kind, kind),
      ),
    )
    .run();
}
