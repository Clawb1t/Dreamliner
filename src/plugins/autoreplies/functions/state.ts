import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { autoreplyState } from "../../../db/schema.js";

export async function shouldTriggerAutoreplyByCadence(input: {
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
    .from(autoreplyState)
    .where(
      and(
        eq(autoreplyState.guildId, input.guildId),
        eq(autoreplyState.ruleId, input.ruleId),
        eq(autoreplyState.channelId, input.channelId),
      ),
    )
    .get();

  const nextCount = (existing?.messageCount ?? 0) + 1;
  const lastTriggeredAt = existing?.lastTriggeredAt?.getTime() ?? 0;

  if (input.cooldownSeconds && input.cooldownSeconds > 0 && lastTriggeredAt > 0) {
    const elapsed = (now - lastTriggeredAt) / 1000;
    if (elapsed < input.cooldownSeconds) {
      await db
        .insert(autoreplyState)
        .values({
          guildId: input.guildId,
          ruleId: input.ruleId,
          channelId: input.channelId,
          messageCount: nextCount,
          lastTriggeredAt: existing?.lastTriggeredAt ?? null,
        })
        .onConflictDoUpdate({
          target: [autoreplyState.guildId, autoreplyState.ruleId, autoreplyState.channelId],
          set: { messageCount: nextCount },
        });
      return false;
    }
  }

  const cadenceOk = !input.everyN || nextCount % input.everyN === 0;
  const triggered = cadenceOk;

  await db
    .insert(autoreplyState)
    .values({
      guildId: input.guildId,
      ruleId: input.ruleId,
      channelId: input.channelId,
      messageCount: nextCount,
      lastTriggeredAt: triggered ? new Date(now) : existing?.lastTriggeredAt ?? null,
    })
    .onConflictDoUpdate({
      target: [autoreplyState.guildId, autoreplyState.ruleId, autoreplyState.channelId],
      set: {
        messageCount: nextCount,
        ...(triggered ? { lastTriggeredAt: new Date(now) } : {}),
      },
    });

  return triggered;
}
