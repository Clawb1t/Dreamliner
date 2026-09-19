import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { countingChannels } from "../../../db/schema.js";

export type CountingState = {
  guildId: string;
  channelId: string;
  currentCount: number;
  lastUserId: string | null;
  lastMessageId: string | null;
  highestCount: number;
  totalResets: number;
  lastCountAt: Date | null;
};

export async function getCountingState(guildId: string, channelId: string): Promise<CountingState | null> {
  const row = await getDb()
    .select()
    .from(countingChannels)
    .where(and(eq(countingChannels.guildId, guildId), eq(countingChannels.channelId, channelId)))
    .get();
  return row ?? null;
}

export async function recordSuccessfulCount(input: {
  guildId: string;
  channelId: string;
  count: number;
  highestCount: number;
  userId: string;
  messageId: string;
  now: Date;
}): Promise<void> {
  await getDb()
    .insert(countingChannels)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      currentCount: input.count,
      lastUserId: input.userId,
      lastMessageId: input.messageId,
      highestCount: input.highestCount,
      totalResets: 0,
      lastCountAt: input.now,
    })
    .onConflictDoUpdate({
      target: [countingChannels.guildId, countingChannels.channelId],
      set: {
        currentCount: input.count,
        lastUserId: input.userId,
        lastMessageId: input.messageId,
        highestCount: input.highestCount,
        lastCountAt: input.now,
      },
    });
}

export async function resetCountingState(input: {
  guildId: string;
  channelId: string;
  resetCount: number;
  highestCount: number;
  now: Date;
}): Promise<void> {
  const existing = await getCountingState(input.guildId, input.channelId);
  await getDb()
    .insert(countingChannels)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      currentCount: input.resetCount,
      lastUserId: null,
      lastMessageId: null,
      highestCount: input.highestCount,
      totalResets: (existing?.totalResets ?? 0) + 1,
      lastCountAt: input.now,
    })
    .onConflictDoUpdate({
      target: [countingChannels.guildId, countingChannels.channelId],
      set: {
        currentCount: input.resetCount,
        lastUserId: null,
        highestCount: input.highestCount,
        totalResets: (existing?.totalResets ?? 0) + 1,
        lastCountAt: input.now,
      },
    });
}
