import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { autothreadState } from "../../../db/schema.js";

export async function shouldTriggerAutothreadByCadence(input: {
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
    .from(autothreadState)
    .where(
      and(
        eq(autothreadState.guildId, input.guildId),
        eq(autothreadState.ruleId, input.ruleId),
        eq(autothreadState.channelId, input.channelId),
      ),
    )
    .get();

  const nextCount = (existing?.messageCount ?? 0) + 1;
  const lastTriggeredAt = existing?.lastTriggeredAt?.getTime() ?? 0;

  if (input.cooldownSeconds && input.cooldownSeconds > 0 && lastTriggeredAt > 0) {
    const elapsed = (now - lastTriggeredAt) / 1000;
    if (elapsed < input.cooldownSeconds) {
      await db
        .insert(autothreadState)
        .values({
          guildId: input.guildId,
          ruleId: input.ruleId,
          channelId: input.channelId,
          messageCount: nextCount,
          lastTriggeredAt: existing?.lastTriggeredAt ?? null,
        })
        .onConflictDoUpdate({
          target: [autothreadState.guildId, autothreadState.ruleId, autothreadState.channelId],
          set: { messageCount: nextCount },
        });
      return false;
    }
  }

  const cadenceOk = !input.everyN || nextCount % input.everyN === 0;
  const triggered = cadenceOk;

  await db
    .insert(autothreadState)
    .values({
      guildId: input.guildId,
      ruleId: input.ruleId,
      channelId: input.channelId,
      messageCount: nextCount,
      lastTriggeredAt: triggered ? new Date(now) : existing?.lastTriggeredAt ?? null,
    })
    .onConflictDoUpdate({
      target: [autothreadState.guildId, autothreadState.ruleId, autothreadState.channelId],
      set: {
        messageCount: nextCount,
        ...(triggered ? { lastTriggeredAt: new Date(now) } : {}),
      },
    });

  return triggered;
}
