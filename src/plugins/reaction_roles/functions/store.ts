import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { reactionRoleMappings } from "../../../db/schema.js";

export type ReactionRoleMapping = {
  guildId: string;
  messageId: string;
  emoji: string;
  roleId: string;
  removeOnUnreact: boolean;
};

export async function getReactionRoleMapping(
  guildId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionRoleMapping | undefined> {
  const row = await getDb()
    .select()
    .from(reactionRoleMappings)
    .where(
      and(
        eq(reactionRoleMappings.guildId, guildId),
        eq(reactionRoleMappings.messageId, messageId),
        eq(reactionRoleMappings.emoji, emoji),
      ),
    )
    .get();

  if (!row) return undefined;
  return {
    guildId: row.guildId,
    messageId: row.messageId,
    emoji: row.emoji,
    roleId: row.roleId,
    removeOnUnreact: row.removeOnUnreact,
  };
}

export async function listReactionRoleMappings(guildId: string, messageId: string): Promise<ReactionRoleMapping[]> {
  const rows = await getDb()
    .select()
    .from(reactionRoleMappings)
    .where(and(eq(reactionRoleMappings.guildId, guildId), eq(reactionRoleMappings.messageId, messageId)))
    .all();

  return rows.map((row) => ({
    guildId: row.guildId,
    messageId: row.messageId,
    emoji: row.emoji,
    roleId: row.roleId,
    removeOnUnreact: row.removeOnUnreact,
  }));
}

export async function createReactionRoleMapping(input: ReactionRoleMapping): Promise<void> {
  await getDb()
    .insert(reactionRoleMappings)
    .values({
      guildId: input.guildId,
      messageId: input.messageId,
      emoji: input.emoji,
      roleId: input.roleId,
      removeOnUnreact: input.removeOnUnreact,
    })
    .onConflictDoUpdate({
      target: [reactionRoleMappings.guildId, reactionRoleMappings.messageId, reactionRoleMappings.emoji],
      set: {
        roleId: input.roleId,
        removeOnUnreact: input.removeOnUnreact,
      },
    });
}

export async function deleteReactionRoleMapping(guildId: string, messageId: string, emoji: string): Promise<boolean> {
  const result = await getDb()
    .delete(reactionRoleMappings)
    .where(
      and(
        eq(reactionRoleMappings.guildId, guildId),
        eq(reactionRoleMappings.messageId, messageId),
        eq(reactionRoleMappings.emoji, emoji),
      ),
    );
  return (result.changes ?? 0) > 0;
}

export async function deleteReactionRoleMappingsForMessage(guildId: string, messageId: string): Promise<number> {
  const result = await getDb()
    .delete(reactionRoleMappings)
    .where(and(eq(reactionRoleMappings.guildId, guildId), eq(reactionRoleMappings.messageId, messageId)));
  return result.changes ?? 0;
}

export async function findReactionRoleMappingByReaction(
  guildId: string,
  messageId: string,
  emoji: import("discord.js").MessageReaction["emoji"],
): Promise<ReactionRoleMapping | undefined> {
  const mappings = await listReactionRoleMappings(guildId, messageId);
  const { emojiKeysMatch } = await import("../../../core/emoji.js");
  return mappings.find((m) => emojiKeysMatch(m.emoji, emoji));
}
