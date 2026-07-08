import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { starboardPosts } from "../../../db/schema.js";

export type StarboardPostRow = {
  guildId: string;
  boardName: string;
  sourceMessageId: string;
  sourceChannelId: string;
  starboardMessageId: string;
  starCount: number;
  createdAt: Date;
};

export async function getStarboardPost(
  guildId: string,
  boardName: string,
  sourceMessageId: string,
): Promise<StarboardPostRow | undefined> {
  const row = await getDb()
    .select()
    .from(starboardPosts)
    .where(
      and(
        eq(starboardPosts.guildId, guildId),
        eq(starboardPosts.boardName, boardName),
        eq(starboardPosts.sourceMessageId, sourceMessageId),
      ),
    )
    .get();

  if (!row) return undefined;
  return {
    guildId: row.guildId,
    boardName: row.boardName,
    sourceMessageId: row.sourceMessageId,
    sourceChannelId: row.sourceChannelId,
    starboardMessageId: row.starboardMessageId,
    starCount: row.starCount,
    createdAt: row.createdAt,
  };
}

export async function createStarboardPost(input: {
  guildId: string;
  boardName: string;
  sourceMessageId: string;
  sourceChannelId: string;
  starboardMessageId: string;
  starCount: number;
}): Promise<void> {
  await getDb()
    .insert(starboardPosts)
    .values({
      guildId: input.guildId,
      boardName: input.boardName,
      sourceMessageId: input.sourceMessageId,
      sourceChannelId: input.sourceChannelId,
      starboardMessageId: input.starboardMessageId,
      starCount: input.starCount,
      createdAt: new Date(),
    });
}

export async function updateStarboardPostStarCount(
  guildId: string,
  boardName: string,
  sourceMessageId: string,
  starCount: number,
): Promise<void> {
  await getDb()
    .update(starboardPosts)
    .set({ starCount })
    .where(
      and(
        eq(starboardPosts.guildId, guildId),
        eq(starboardPosts.boardName, boardName),
        eq(starboardPosts.sourceMessageId, sourceMessageId),
      ),
    );
}

export async function deleteStarboardPost(guildId: string, boardName: string, sourceMessageId: string): Promise<void> {
  await getDb()
    .delete(starboardPosts)
    .where(
      and(
        eq(starboardPosts.guildId, guildId),
        eq(starboardPosts.boardName, boardName),
        eq(starboardPosts.sourceMessageId, sourceMessageId),
      ),
    );
}

export async function deleteStarboardPostsForSourceMessage(guildId: string, sourceMessageId: string): Promise<StarboardPostRow[]> {
  const rows = await getDb()
    .select()
    .from(starboardPosts)
    .where(and(eq(starboardPosts.guildId, guildId), eq(starboardPosts.sourceMessageId, sourceMessageId)))
    .all();

  if (rows.length === 0) return [];

  await getDb()
    .delete(starboardPosts)
    .where(and(eq(starboardPosts.guildId, guildId), eq(starboardPosts.sourceMessageId, sourceMessageId)));

  return rows.map((row) => ({
    guildId: row.guildId,
    boardName: row.boardName,
    sourceMessageId: row.sourceMessageId,
    sourceChannelId: row.sourceChannelId,
    starboardMessageId: row.starboardMessageId,
    starCount: row.starCount,
    createdAt: row.createdAt,
  }));
}

export async function deleteStarboardPostsForStarboardMessage(guildId: string, starboardMessageId: string): Promise<void> {
  await getDb()
    .delete(starboardPosts)
    .where(and(eq(starboardPosts.guildId, guildId), eq(starboardPosts.starboardMessageId, starboardMessageId)));
}
