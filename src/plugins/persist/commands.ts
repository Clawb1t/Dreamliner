import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { listPersistedMessages, removePersistedMessage, upsertPersistedMessage } from "./functions/store.js";

export const persistCommands: SlashCommandDefinition[] = [
  {
    plugin: "persist",
    data: new SlashCommandBuilder()
      .setName("persist")
      .setDescription("Manage sticky persisted messages")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Persist a message in this channel")
          .addStringOption((o) => o.setName("message_id").setDescription("Message ID to persist").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove persisted message from a channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Channel (defaults to current)")),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List persisted messages")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "persist", "can_add");
        if (!auth) return;

        const channel = ctx.interaction.channel;
        if (!channel?.isTextBased() || channel.isDMBased()) {
          await ctx.interaction.reply(
            resultReply("Persist", "Use this command in a text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const messageId = ctx.interaction.options.getString("message_id", true);
        const fetched = await channel.messages.fetch(messageId).catch(() => null);
        if (!fetched) {
          await ctx.interaction.reply(
            resultReply("Persist", "Message not found in this channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        if (!fetched.content) {
          await ctx.interaction.reply(
            resultReply("Persist", "Message has no text content to persist.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await upsertPersistedMessage({
          guildId,
          channelId: channel.id,
          messageId: fetched.id,
          content: fetched.content,
        });

        await ctx.interaction.reply(
          resultReply(
            "Message persisted",
            `Sticky message set in <#${channel.id}> for message \`${fetched.id}\`.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "persist", "can_remove");
        if (!auth) return;

        const channelRef = ctx.interaction.options.getChannel("channel") ?? ctx.interaction.channel;
        if (!channelRef) {
          await ctx.interaction.reply(
            resultReply("Persist", "Invalid channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const channel = await ctx.interaction.guild!.channels.fetch(channelRef.id).catch(() => null);
        if (!channel?.isTextBased() || channel.isDMBased()) {
          await ctx.interaction.reply(
            resultReply("Persist", "Invalid channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const removed = await removePersistedMessage(guildId, channel.id);
        if (!removed) {
          await ctx.interaction.reply(
            resultReply("Persist", `No persisted message in <#${channel.id}>.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply("Persist removed", `Removed sticky message from <#${channel.id}>.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "persist", "can_list");
        if (!auth) return;

        const rows = await listPersistedMessages(guildId);
        if (!rows.length) {
          await ctx.interaction.reply(
            resultReply("Persisted messages", "None configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const lines = rows.map(
          (r) => `<#${r.channelId}> · \`${r.messageId}\` (${r.content.slice(0, 80)}${r.content.length > 80 ? "…" : ""})`,
        );
        await ctx.interaction.reply(
          resultReply("Persisted messages", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
