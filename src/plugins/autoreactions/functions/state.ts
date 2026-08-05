import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { autoreactionState } from "../../../db/schema.js";

export async function shouldTriggerByCadence(input: {
  guildId: string;
  ruleId: number;
  channelId: string;
  everyN?: number;
  cooldownSeconds?: number;
}): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  const existing = await db
    .select()
    .from(autoreactionState)
    .where(
      and(
        eq(autoreactionState.guildId, input.guildId),
        eq(autoreactionState.ruleId, input.ruleId),
        eq(autoreactionState.channelId, input.channelId),
      ),
    )
    .get();

  const nextCount = (existing?.messageCount ?? 0) + 1;
  const lastTriggeredAt = existing?.lastTriggeredAt?.getTime() ?? 0;

  if (input.cooldownSeconds && input.cooldownSeconds > 0 && lastTriggeredAt > 0) {
    const elapsed = (now - lastTriggeredAt) / 1000;
    if (elapsed < input.cooldownSeconds) {
      await db
        .insert(autoreactionState)
        .values({
          guildId: input.guildId,
          ruleId: input.ruleId,
          channelId: input.channelId,
          messageCount: nextCount,
          lastTriggeredAt: existing?.lastTriggeredAt ?? null,
        })
        .onConflictDoUpdate({
          target: [autoreactionState.guildId, autoreactionState.ruleId, autoreactionState.channelId],
          set: { messageCount: nextCount },
        });
      return false;
    }
  }

  const cadenceOk = !input.everyN || nextCount % input.everyN === 0;
  const triggered = cadenceOk;

  await db
    .insert(autoreactionState)
    .values({
      guildId: input.guildId,
      ruleId: input.ruleId,
      channelId: input.channelId,
      messageCount: nextCount,
      lastTriggeredAt: triggered ? new Date(now) : existing?.lastTriggeredAt ?? null,
    })
    .onConflictDoUpdate({
      target: [autoreactionState.guildId, autoreactionState.ruleId, autoreactionState.channelId],
      set: {
        messageCount: nextCount,
        ...(triggered ? { lastTriggeredAt: new Date(now) } : {}),
      },
    });

  return triggered;
}
