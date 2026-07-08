import { SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import type { TextChannel } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, resultEdit, embedWithFilesReply, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { buildResultEmbed, trimLines } from "../../../core/embeds.js";
import { requireUtilityPermission, ManageMessages, requireDiscordPerm } from "../functions/commandHelpers.js";
import { collectMessagesForClean, serializeMessages, archiveMessages, archiveSingleMessage } from "../functions/clean.js";
import { buildCleanLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { getInfractionPluginConfig } from "../../../core/guildHelpers.js";
import { createInfraction, postCaseLog } from "../../infraction/functions/infractions.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";

export const moderationCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_clean",
    data: new SlashCommandBuilder()
      .setName("clean")
      .setDescription("Bulk delete messages with optional filters")
      .addIntegerOption((o) => o.setName("amount").setDescription("Number of messages (max 100)").setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName("user").setDescription("Only messages from this user"))
      .addBooleanOption((o) => o.setName("bots_only").setDescription("Only bot messages"))
      .addBooleanOption((o) => o.setName("pins_only").setDescription("Only pinned messages"))
      .addBooleanOption((o) => o.setName("contains_invite").setDescription("Only messages with invites"))
      .addStringOption((o) => o.setName("regex").setDescription("Filter by regex"))
      .addBooleanOption((o) => o.setName("update_case").setDescription("Record a mod case for this clean")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_clean");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, ManageMessages, "Manage Messages", ctx.ephemeral, ctx.guildConfig))) return;

      const channel = ctx.interaction.channel;
      if (!channel?.isTextBased() || channel.isDMBased() || !("bulkDelete" in channel)) {
        await ctx.interaction.reply(resultReply("Clean", "This command must be used in a text channel.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const textChannel = channel as TextChannel;

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const amount = ctx.interaction.options.getInteger("amount", true);
      const user = ctx.interaction.options.getUser("user");

      const messages = await collectMessagesForClean(textChannel, {
        limit: amount,
        userId: user?.id,
        botsOnly: ctx.interaction.options.getBoolean("bots_only") ?? false,
        pinsOnly: ctx.interaction.options.getBoolean("pins_only") ?? false,
        containsInvite: ctx.interaction.options.getBoolean("contains_invite") ?? false,
        regex: ctx.interaction.options.getString("regex") ?? undefined,
      });

      const deletable = messages.filter((m) => !m.pinned || (ctx.interaction.options.getBoolean("pins_only") ?? false));
      if (deletable.size === 0) {
        await ctx.interaction.editReply(resultEdit("Clean", "No messages matched your filters.", slashResultOptions(ctx)));
        return;
      }

      const serialized = serializeMessages([...deletable.values()]);
      const archiveId = await archiveMessages(ctx.interaction.guildId!, serialized);

      const deleted = await textChannel.bulkDelete(deletable, true).catch(() => null);
      const count = deleted?.size ?? 0;

      await sendModerationLog(
        ctx.client,
        ctx.guildConfig,
        buildCleanLog({
          mod: {
            id: ctx.interaction.user.id,
            name: ctx.interaction.user.username,
            avatarUrl: ctx.interaction.user.displayAvatarURL({ size: 128 }),
          },
          channel: { id: textChannel.id, name: textChannel.name },
          count,
          archiveId,
        }),
      );

      if (ctx.interaction.options.getBoolean("update_case")) {
        const record = await createInfraction({
          guildId: ctx.interaction.guildId!,
          userId: user?.id ?? "0",
          modId: ctx.interaction.user.id,
          type: "clean",
          reason: `Deleted ${count} messages (archive ${archiveId})`,
          active: false,
        });
        const pluginConfig = getInfractionPluginConfig(ctx.guildConfig) as InfractionConfig;
        await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig, record, user, ctx.interaction.user);
      }

      await ctx.interaction.editReply(
        resultEdit(
          "Clean",
          trimLines(`
            Deleted: **${count}** message(s)
            Archive ID: \`${archiveId}\`
          `),
          slashResultOptions(ctx),
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_context",
    data: new SlashCommandBuilder()
      .setName("context")
      .setDescription("Get a link to the message before the given message")
      .addStringOption((o) => o.setName("message_id").setDescription("Message ID").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_context");
      if (!auth) return;
      const channel = ctx.interaction.channel;
      if (!channel?.isTextBased() || channel.isDMBased()) return;

      const messageId = ctx.interaction.options.getString("message_id", true);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) {
        await ctx.interaction.reply(resultReply("Context", "Message not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const prior = await channel.messages.fetch({ limit: 1, before: message.id }).catch(() => null);
      const priorMsg = prior?.first();
      if (!priorMsg) {
        await ctx.interaction.reply(resultReply("Context", "No prior message found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const link = `https://discord.com/channels/${ctx.interaction.guildId}/${channel.id}/${priorMsg.id}`;
      await ctx.interaction.reply(
        resultReply("Context", `Prior message: [**Go to message ➔**](${link})`, ctx.ephemeral, slashResultOptions(ctx)),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_source",
    data: new SlashCommandBuilder()
      .setName("source")
      .setDescription("Get the full JSON source of a message")
      .addStringOption((o) => o.setName("message_id").setDescription("Message ID").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_source");
      if (!auth) return;
      const channel = ctx.interaction.channel;
      if (!channel?.isTextBased() || channel.isDMBased()) return;

      const messageId = ctx.interaction.options.getString("message_id", true);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) {
        await ctx.interaction.reply(resultReply("Source", "Message not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const archiveId = await archiveSingleMessage(ctx.interaction.guildId!, message);
      const json = JSON.stringify(message.toJSON(), null, 2);
      const file = new AttachmentBuilder(Buffer.from(json, "utf-8"), { name: `message-${message.id}.json` });

      await ctx.interaction.reply(
        embedWithFilesReply(
          buildResultEmbed(
            `Message: ${message.id}`,
            trimLines(`
              Archive ID: \`${archiveId}\`
              The full message JSON is attached.
            `),
            slashResultOptions(ctx),
          ),
          [file],
          ctx.ephemeral,
        ),
      );
    },
  },
];
