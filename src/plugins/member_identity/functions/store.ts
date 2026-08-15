import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { memberIdentity } from "../../../db/schema.js";

export type MemberIdentitySnapshot = {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string[];
  timeoutUntil: number | null;
  username: string;
  updatedAt: Date;
};

function parseRoleIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function fromRow(row: {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string;
  timeoutUntil: number | null;
  username: string;
  updatedAt: Date;
}): MemberIdentitySnapshot {
  return {
    guildId: row.guildId,
    userId: row.userId,
    nickname: row.nickname,
    roleIds: parseRoleIds(row.roleIds),
    timeoutUntil: row.timeoutUntil,
    username: row.username,
    updatedAt: row.updatedAt,
  };
}

export async function getMemberIdentity(
  guildId: string,
  userId: string,
): Promise<MemberIdentitySnapshot | null> {
  const row = await getDb()
    .select()
    .from(memberIdentity)
    .where(and(eq(memberIdentity.guildId, guildId), eq(memberIdentity.userId, userId)))
    .get();
  return row ? fromRow(row) : null;
}

export async function upsertMemberIdentity(input: {
  guildId: string;
  userId: string;
  nickname: string;
  roleIds: string[];
  timeoutUntil: number | null;
  username: string;
}): Promise<void> {
  const updatedAt = new Date();
  const roleIds = JSON.stringify(input.roleIds);
  await getDb()
    .insert(memberIdentity)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      nickname: input.nickname,
      roleIds,
      timeoutUntil: input.timeoutUntil,
      username: input.username,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [memberIdentity.guildId, memberIdentity.userId],
      set: {
        nickname: input.nickname,
        roleIds,
        timeoutUntil: input.timeoutUntil,
        username: input.username,
        updatedAt,
      },
    });
}
