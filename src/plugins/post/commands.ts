import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { createScheduledPost, deleteScheduledPost, listScheduledPosts } from "./functions/store.js";

export const postCommands: SlashCommandDefinition[] = [
  {
    plugin: "post",
    data: new SlashCommandBuilder()
      .setName("post")
      .setDescription("Schedule messages to be posted later")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Schedule a message")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel").addChannelTypes(ChannelType.GuildText).setRequired(true),
          )
          .addStringOption((o) => o.setName("content").setDescription("Message content").setRequired(true))
          .addIntegerOption((o) =>
            o.setName("delay").setDescription("Delay in minutes").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List scheduled posts"))
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a scheduled post")
          .addIntegerOption((o) => o.setName("id").setDescription("Post ID").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "post", "can_create");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const content = ctx.interaction.options.getString("content", true);
        const delay = ctx.interaction.options.getInteger("delay", true);

        const post = await createScheduledPost({
          guildId,
          channelId: channel.id,
          content,
          delayMinutes: delay,
          createdBy: ctx.interaction.user.id,
        });

        await ctx.interaction.reply(
          resultReply(
            "Post scheduled",
            `Post **#${post.id}** will be sent to <#${channel.id}> in **${delay}** minute(s).`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "post", "can_list");
        if (!auth) return;

        const posts = await listScheduledPosts(guildId);
        if (posts.length === 0) {
          await ctx.interaction.reply(resultReply("Scheduled posts", "No scheduled posts.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = posts.map((post) => {
          const when = post.nextRunAt ? `<t:${Math.floor(post.nextRunAt.getTime() / 1000)}:R>` : "unknown";
          return `**#${post.id}** → <#${post.channelId}> ${when}`;
        });
        await ctx.interaction.reply(resultReply("Scheduled posts", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "post", "can_delete");
        if (!auth) return;

        const id = ctx.interaction.options.getInteger("id", true);
        const deleted = await deleteScheduledPost(guildId, id);
        if (!deleted) {
          await ctx.interaction.reply(resultReply("Not found", `No scheduled post **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await ctx.interaction.reply(resultReply("Post deleted", `Deleted scheduled post **#${id}**.`, ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
