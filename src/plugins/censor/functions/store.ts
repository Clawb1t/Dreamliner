import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { censorRules } from "../../../db/schema.js";

export type CensorRuleRow = {
  id: number;
  guildId: string;
  pattern: string;
  regex: boolean;
  action: string;
  createdAt: Date;
};

export async function listCensorRules(guildId: string): Promise<CensorRuleRow[]> {
  const rows = await getDb().select().from(censorRules).where(eq(censorRules.guildId, guildId)).all();
  return rows.map((row) => ({
    id: row.id,
    guildId: row.guildId,
    pattern: row.pattern,
    regex: row.regex,
    action: row.action,
    createdAt: row.createdAt,
  }));
}

export async function addCensorRule(input: {
  guildId: string;
  pattern: string;
  regex: boolean;
  action: string;
}): Promise<CensorRuleRow> {
  const result = await getDb()
    .insert(censorRules)
    .values({
      guildId: input.guildId,
      pattern: input.pattern,
      regex: input.regex,
      action: input.action,
      createdAt: new Date(),
    })
    .returning()
    .get();

  return {
    id: result.id,
    guildId: result.guildId,
    pattern: result.pattern,
    regex: result.regex,
    action: result.action,
    createdAt: result.createdAt,
  };
}

export async function removeCensorRule(guildId: string, id: number): Promise<boolean> {
  const result = await getDb()
    .delete(censorRules)
    .where(and(eq(censorRules.guildId, guildId), eq(censorRules.id, id)))
    .returning()
    .get();
  return Boolean(result);
}
