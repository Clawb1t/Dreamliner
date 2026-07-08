import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { parseMessageLink } from "../../../core/messageLink.js";
import { normalizeEmojiInput } from "../../../core/emoji.js";
import {
  createReactionRoleMapping,
  deleteReactionRoleMapping,
  deleteReactionRoleMappingsForMessage,
  listReactionRoleMappings,
} from "../functions/store.js";

export const reactionRoleCommands: SlashCommandDefinition[] = [
  {
    plugin: "reaction_roles",
    data: new SlashCommandBuilder()
      .setName("reactionrole")
      .setDescription("Manage reaction roles")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Add a reaction role to a message")
          .addStringOption((o) => o.setName("message_link").setDescription("Message link").setRequired(true))
          .addStringOption((o) => o.setName("emoji").setDescription("Emoji to react with").setRequired(true))
          .addRoleOption((o) => o.setName("role").setDescription("Role to assign").setRequired(true))
          .addBooleanOption((o) =>
            o.setName("remove_on_unreact").setDescription("Remove role when reaction is removed (default: true)"),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Remove a reaction role mapping")
          .addStringOption((o) => o.setName("message_link").setDescription("Message link").setRequired(true))
          .addStringOption((o) => o.setName("emoji").setDescription("Emoji (omit to remove all mappings on message)")),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "reaction_roles", "can_create");
        if (!auth) return;

        const link = parseMessageLink(ctx.interaction.options.getString("message_link", true));
        if (!link || link.guildId !== guildId) {
          await ctx.interaction.reply(
            resultReply("Invalid link", "Provide a message link from this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const emoji = normalizeEmojiInput(ctx.interaction.options.getString("emoji", true));
        const role = ctx.interaction.options.getRole("role", true);
        const removeOnUnreact = ctx.interaction.options.getBoolean("remove_on_unreact") ?? true;

        const channel = await ctx.interaction.guild!.channels.fetch(link.channelId).catch(() => null);
        if (!channel?.isTextBased()) {
          await ctx.interaction.reply(
            resultReply("Channel not found", "Could not access that channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const message = await channel.messages.fetch(link.messageId).catch(() => null);
        if (!message) {
          await ctx.interaction.reply(
            resultReply("Message not found", "Could not fetch that message.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await createReactionRoleMapping({
          guildId,
          messageId: link.messageId,
          emoji,
          roleId: role.id,
          removeOnUnreact,
        });

        await message.react(emoji).catch(() => null);

        await ctx.interaction.reply(
          resultReply(
            "Reaction role created",
            `${emoji} → ${role} on [message](${ctx.interaction.options.getString("message_link", true)})`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "reaction_roles", "can_delete");
        if (!auth) return;

        const link = parseMessageLink(ctx.interaction.options.getString("message_link", true));
        if (!link || link.guildId !== guildId) {
          await ctx.interaction.reply(
            resultReply("Invalid link", "Provide a message link from this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const emojiRaw = ctx.interaction.options.getString("emoji");
        if (!emojiRaw) {
          const count = await deleteReactionRoleMappingsForMessage(guildId, link.messageId);
          await ctx.interaction.reply(
            resultReply("Reaction roles deleted", `Removed ${count} mapping(s) from that message.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const emoji = normalizeEmojiInput(emojiRaw);
        const deleted = await deleteReactionRoleMapping(guildId, link.messageId, emoji);
        if (!deleted) {
          const mappings = await listReactionRoleMappings(guildId, link.messageId);
          const match = mappings.find((m) => m.emoji === emoji);
          if (match) {
            await deleteReactionRoleMapping(guildId, link.messageId, match.emoji);
          } else {
            await ctx.interaction.reply(
              resultReply("Not found", "No reaction role mapping matched that emoji.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
        }

        await ctx.interaction.reply(
          resultReply("Reaction role deleted", `Removed ${emoji} mapping from that message.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
