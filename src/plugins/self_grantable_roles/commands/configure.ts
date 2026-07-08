import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import type { SelfGrantableRolesConfig } from "../../../config/schemas/plugins.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { upsertSelfRolePanel } from "../functions/store.js";
import { buildSelfRoleComponents } from "../functions/panel.js";

const MAX_ROLE_OPTIONS = 10;

export const selfRoleCommands: SlashCommandDefinition[] = [
  {
    plugin: "self_grantable_roles",
    data: (() => {
      const sub = new SlashCommandBuilder()
        .setName("selfrole")
        .setDescription("Configure self-assignable roles")
        .addSubcommand((subcommand) => {
          let cmd = subcommand
            .setName("configure")
            .setDescription("Post a self-role panel in a channel")
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Channel for the panel").addChannelTypes(ChannelType.GuildText).setRequired(true),
            );

          for (let i = 1; i <= MAX_ROLE_OPTIONS; i++) {
            cmd = cmd.addRoleOption((o) =>
              o
                .setName(`role_${i}`)
                .setDescription(i === 1 ? "First role" : `Additional role ${i}`)
                .setRequired(i === 1),
            );
          }

          return cmd
            .addStringOption((o) =>
              o
                .setName("style")
                .setDescription("Panel style")
                .addChoices(
                  { name: "Buttons", value: "buttons" },
                  { name: "Select menu", value: "select" },
                ),
            )
            .addStringOption((o) => o.setName("content").setDescription("Message content"));
        });
      return sub;
    })(),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "self_grantable_roles", "can_configure");
      if (!auth) return;

      const pluginConfig = auth.pluginConfig as SelfGrantableRolesConfig;
      const channelOpt = ctx.interaction.options.getChannel("channel", true);
      const channel = await ctx.interaction.guild!.channels.fetch(channelOpt.id).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased()) {
        await ctx.interaction.reply(
          resultReply("Invalid channel", "Choose a text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const roleIds: string[] = [];
      for (let i = 1; i <= MAX_ROLE_OPTIONS; i++) {
        const role = ctx.interaction.options.getRole(`role_${i}`);
        if (role) roleIds.push(role.id);
      }

      if (roleIds.length === 0) {
        await ctx.interaction.reply(
          resultReply("No roles", "Select at least one role.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const maxRoles = pluginConfig.max_roles_per_panel ?? 10;
      if (roleIds.length > maxRoles) {
        await ctx.interaction.reply(
          resultReply("Too many roles", `Maximum ${maxRoles} roles per panel.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const guild = ctx.interaction.guild!;
      const validRoleIds = [...new Set(roleIds.filter((id) => guild.roles.cache.has(id)))];
      if (validRoleIds.length === 0) {
        await ctx.interaction.reply(
          resultReply("Invalid roles", "None of the selected roles exist in this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const style = (ctx.interaction.options.getString("style") ?? "buttons") as "buttons" | "select";
      const content = ctx.interaction.options.getString("content") ?? "Choose your roles below.";

      const message = await channel.send({ content, components: [] });
      const config = { roleIds: validRoleIds, style };
      await upsertSelfRolePanel(guild.id, message.id, config);

      await message.edit({ components: buildSelfRoleComponents(guild, message.id, config) });

      const roleList = validRoleIds.map((id) => guild.roles.cache.get(id)!.toString()).join(", ");
      await ctx.interaction.reply(
        resultReply(
          "Self-role panel created",
          `Posted in ${channel} with ${validRoleIds.length} role(s): ${roleList}`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
];
