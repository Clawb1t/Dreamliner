import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { parseMessageLink } from "../../../core/messageLink.js";
import {
  createRoleButtonPanel,
  deleteRoleButtonPanel,
  deleteRoleButtonPanelsForMessage,
  listRoleButtonsForMessage,
} from "../functions/store.js";
import { buildRoleButtonRows } from "../functions/handlers.js";

export const roleButtonCommands: SlashCommandDefinition[] = [
  {
    plugin: "role_buttons",
    data: new SlashCommandBuilder()
      .setName("rolebutton")
      .setDescription("Manage role buttons")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create or extend a role button panel")
          .addRoleOption((o) => o.setName("role").setDescription("Role to toggle").setRequired(true))
          .addStringOption((o) => o.setName("label").setDescription("Button label (defaults to role name)"))
          .addStringOption((o) =>
            o
              .setName("style")
              .setDescription("Button style")
              .addChoices(
                { name: "Primary", value: "primary" },
                { name: "Secondary", value: "secondary" },
                { name: "Success", value: "success" },
                { name: "Danger", value: "danger" },
              ),
          )
          .addStringOption((o) => o.setName("content").setDescription("Message content for a new panel"))
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Channel for a new panel").addChannelTypes(ChannelType.GuildText),
          )
          .addStringOption((o) => o.setName("message_link").setDescription("Add a button to an existing message")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Remove role button mappings")
          .addStringOption((o) => o.setName("message_link").setDescription("Message link").setRequired(true))
          .addRoleOption((o) => o.setName("role").setDescription("Role button to remove (omit for all on message)")),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "role_buttons", "can_create");
        if (!auth) return;

        const role = ctx.interaction.options.getRole("role", true);
        const label = ctx.interaction.options.getString("label") ?? role.name;
        const style = ctx.interaction.options.getString("style") ?? "secondary";
        const messageLink = ctx.interaction.options.getString("message_link");
        const content = ctx.interaction.options.getString("content");
        const channelOpt = ctx.interaction.options.getChannel("channel");

        let messageId: string;
        let channelId: string;

        if (messageLink) {
          const link = parseMessageLink(messageLink);
          if (!link || link.guildId !== guildId) {
            await ctx.interaction.reply(
              resultReply("Invalid link", "Provide a message link from this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
          messageId = link.messageId;
          channelId = link.channelId;
        } else {
          const targetChannelId = channelOpt?.id ?? ctx.interaction.channelId;
          const channel = await ctx.interaction.guild!.channels.fetch(targetChannelId).catch(() => null);
          if (!channel?.isTextBased() || channel.isDMBased()) {
            await ctx.interaction.reply(
              resultReply("Invalid channel", "Choose a text channel or provide a message link.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }

          const sent = await channel.send({ content: content ?? "Click a button to toggle your roles." });
          messageId = sent.id;
          channelId = channel.id;
        }

        await createRoleButtonPanel({
          guildId,
          messageId,
          roleId: role.id,
          label,
          style,
        });

        const panels = await listRoleButtonsForMessage(guildId, messageId);
        const channel = await ctx.interaction.guild!.channels.fetch(channelId).catch(() => null);
        if (channel?.isTextBased()) {
          const message = await channel.messages.fetch(messageId).catch(() => null);
          if (message) {
            await message.edit({ components: buildRoleButtonRows(messageId, panels) }).catch(() => null);
          }
        }

        await ctx.interaction.reply(
          resultReply(
            "Role button created",
            `Added **${label}** → ${role} on message \`${messageId}\`.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "role_buttons", "can_delete");
        if (!auth) return;

        const link = parseMessageLink(ctx.interaction.options.getString("message_link", true));
        if (!link || link.guildId !== guildId) {
          await ctx.interaction.reply(
            resultReply("Invalid link", "Provide a message link from this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const role = ctx.interaction.options.getRole("role");
        if (role) {
          await deleteRoleButtonPanel(guildId, link.messageId, role.id);
        } else {
          await deleteRoleButtonPanelsForMessage(guildId, link.messageId);
        }

        const panels = await listRoleButtonsForMessage(guildId, link.messageId);
        const channel = await ctx.interaction.guild!.channels.fetch(link.channelId).catch(() => null);
        if (channel?.isTextBased()) {
          const message = await channel.messages.fetch(link.messageId).catch(() => null);
          if (message) {
            await message
              .edit({ components: panels.length > 0 ? buildRoleButtonRows(link.messageId, panels) : [] })
              .catch(() => null);
          }
        }

        await ctx.interaction.reply(
          resultReply("Role button deleted", role ? `Removed ${role} from the panel.` : "Removed all buttons from that message.", ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
