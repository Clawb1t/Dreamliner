import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { renderTemplate } from "../../core/templates.js";
import { createTag, deleteTag, getTag, listTags, updateTag } from "./functions/store.js";

export const tagsCommands: SlashCommandDefinition[] = [
  {
    plugin: "tags",
    data: new SlashCommandBuilder()
      .setName("tag")
      .setDescription("Manage server tags")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a tag")
          .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true))
          .addStringOption((o) => o.setName("content").setDescription("Tag content").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit a tag")
          .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true))
          .addStringOption((o) => o.setName("content").setDescription("New content").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a tag")
          .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List all tags"))
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription("Show a tag")
          .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const guild = ctx.interaction.guild!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "tags", "can_create");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const content = ctx.interaction.options.getString("content", true);

        const existing = await getTag(guildId, name);
        if (existing) {
          await ctx.interaction.reply(resultReply("Tag exists", `A tag named **${name}** already exists.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        await createTag({ guildId, name, content, createdBy: ctx.interaction.user.id });
        await ctx.interaction.reply(resultReply("Tag created", `Created tag **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "edit") {
        const auth = await requirePluginPermission(ctx, "tags", "can_edit");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const content = ctx.interaction.options.getString("content", true);
        const updated = await updateTag(guildId, name, content);
        if (!updated) {
          await ctx.interaction.reply(resultReply("Not found", `No tag named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await ctx.interaction.reply(resultReply("Tag updated", `Updated tag **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "tags", "can_delete");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteTag(guildId, name);
        if (!deleted) {
          await ctx.interaction.reply(resultReply("Not found", `No tag named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await ctx.interaction.reply(resultReply("Tag deleted", `Deleted tag **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "tags", "can_list");
        if (!auth) return;

        const rows = await listTags(guildId);
        if (rows.length === 0) {
          await ctx.interaction.reply(resultReply("Tags", "No tags configured.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const names = rows.map((row) => row.name).sort().join(", ");
        await ctx.interaction.reply(resultReply("Tags", names, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "show") {
        const auth = await requirePluginPermission(ctx, "tags", "can_show");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const tag = await getTag(guildId, name);
        if (!tag) {
          await ctx.interaction.reply(resultReply("Not found", `No tag named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const channel = ctx.interaction.channel?.isTextBased() ? ctx.interaction.channel : null;
        const rendered = renderTemplate(tag.content, {
          member: auth.member,
          guild,
          channel: channel?.isTextBased() ? (channel as import("discord.js").TextChannel) : null,
        });

        await ctx.interaction.reply({ content: rendered, ephemeral: false });
      }
    },
  },
];
