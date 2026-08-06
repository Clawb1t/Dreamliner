import {
  DiscordAPIError,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import {
  deferReplyOptions,
  embedWithFilesEdit,
  resultEdit,
  resultReply,
  slashResultOptions,
} from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { normalizeAvatarAttachment } from "../functions/normalizeAvatar.js";
import {
  avatarAttachment,
  markReviewMessageCancelled,
  pendingUserEmbed,
  submitAvatarForReview,
} from "../functions/review.js";
import {
  cancelPendingBotAvatarRequest,
  getPendingBotAvatarRequest,
  updateBotAvatarRequestMessageIds,
} from "../functions/store.js";

const MAX_NICKNAME_LENGTH = 32;

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return "Discord denied the change (missing permissions). Make sure Dreamliner can change its own nickname in this server.";
    }
    if (error.code === 50035) {
      return "Discord rejected that value. Check the nickname length or image format.";
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

export const botCommands: SlashCommandDefinition[] = [
  {
    plugin: "bot_customisation",
    data: new SlashCommandBuilder()
      .setName("bot")
      .setDescription("Customise Dreamliner's appearance in this server")
      .addSubcommandGroup((group) =>
        group
          .setName("avatar")
          .setDescription("Set or clear Dreamliner's per-server avatar")
          .addSubcommand((sub) =>
            sub
              .setName("set")
              .setDescription("Set a custom avatar for Dreamliner in this server")
              .addAttachmentOption((o) =>
                o
                  .setName("image")
                  .setDescription("PNG, JPEG, GIF, or WebP image")
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) =>
            sub.setName("clear").setDescription("Remove Dreamliner's custom avatar in this server"),
          )
          .addSubcommand((sub) =>
            sub
              .setName("cancel")
              .setDescription("Cancel this server's pending avatar review request"),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("nickname")
          .setDescription("Set or clear Dreamliner's server nickname")
          .addSubcommand((sub) =>
            sub
              .setName("set")
              .setDescription("Set Dreamliner's nickname in this server")
              .addStringOption((o) =>
                o
                  .setName("nickname")
                  .setDescription("New nickname (max 32 characters)")
                  .setRequired(true)
                  .setMinLength(1)
                  .setMaxLength(MAX_NICKNAME_LENGTH),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName("clear")
              .setDescription("Remove Dreamliner's nickname in this server"),
          ),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(true);
      const sub = ctx.interaction.options.getSubcommand(true);
      const guild = ctx.interaction.guild;
      if (!guild) {
        await ctx.interaction.reply(
          resultReply(
            "Server only",
            "This command can only be used in a server.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      if (group === "avatar") {
        const auth = await requirePluginPermission(ctx, "bot_customisation", "can_avatar");
        if (!auth) return;

        if (sub === "set") {
          const existing = await getPendingBotAvatarRequest(guild.id);
          if (existing) {
            await ctx.interaction.reply(
              resultReply(
                "Request already queued",
                `This server already has an avatar request waiting for review (id \`${existing.id}\`).\nUse \`/bot avatar cancel\` to remove it before requesting a new one.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "warning" }),
              ),
            );
            return;
          }

          const attachment = ctx.interaction.options.getAttachment("image", true);
          // Public reply so staff decisions can reply to this message after reboot.
          await ctx.interaction.deferReply(deferReplyOptions(false));

          const normalized = await normalizeAvatarAttachment(attachment);
          if (!normalized.ok) {
            await ctx.interaction.editReply(
              resultEdit(normalized.title, normalized.details, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }

          // Re-check after download in case another request slipped in.
          const raced = await getPendingBotAvatarRequest(guild.id);
          if (raced) {
            await ctx.interaction.editReply(
              resultEdit(
                "Request already queued",
                `This server already has an avatar request waiting for review (id \`${raced.id}\`).\nUse \`/bot avatar cancel\` to remove it before requesting a new one.`,
                slashResultOptions(ctx, { tone: "warning" }),
              ),
            );
            return;
          }

          try {
            const { request, reviewPosted } = await submitAvatarForReview({
              client: ctx.client,
              guildId: guild.id,
              guildName: guild.name,
              requesterId: ctx.interaction.user.id,
              requesterTag: ctx.interaction.user.tag,
              requestChannelId: ctx.interaction.channelId,
              avatarPng: normalized.buffer,
            });

            const pendingMessage = await ctx.interaction.editReply(
              embedWithFilesEdit(
                pendingUserEmbed(ctx.client, guild.name, reviewPosted),
                [avatarAttachment(normalized.buffer)],
              ),
            );

            await updateBotAvatarRequestMessageIds(request.id, {
              requestMessageId: pendingMessage.id,
            });
          } catch (error) {
            await ctx.interaction.editReply(
              resultEdit(
                "Could not submit avatar",
                apiErrorMessage(error, "Something went wrong while queuing the avatar for review."),
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
          }
          return;
        }

        if (sub === "cancel") {
          const cancelled = await cancelPendingBotAvatarRequest(guild.id, ctx.interaction.user.id);
          if (!cancelled) {
            await ctx.interaction.reply(
              resultReply(
                "Nothing to cancel",
                "There is no pending avatar request for this server.",
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "warning" }),
              ),
            );
            return;
          }

          await markReviewMessageCancelled(ctx.client, cancelled, ctx.interaction.user.id);

          if (cancelled.requestMessageId && cancelled.requestChannelId) {
            const channel = await ctx.client.channels.fetch(cancelled.requestChannelId).catch(() => null);
            if (channel?.isTextBased() && !channel.isDMBased()) {
              const original = await channel.messages.fetch(cancelled.requestMessageId).catch(() => null);
              if (original) {
                await original
                  .edit(
                    resultEdit(
                      "Avatar request cancelled",
                      `This pending avatar request was cancelled by <@${ctx.interaction.user.id}>. You can submit a new one with \`/bot avatar set\`.`,
                      slashResultOptions(ctx, { tone: "unchecked" }),
                    ),
                  )
                  .catch(() => null);
              }
            }
          }

          await ctx.interaction.reply(
            resultReply(
              "Request cancelled",
              `Pending avatar request \`${cancelled.id}\` was removed. You can run \`/bot avatar set\` again.`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success" }),
            ),
          );
          return;
        }

        // clear
        await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
        try {
          await guild.members.editMe({
            avatar: null,
            reason: `Guild avatar cleared by ${ctx.interaction.user.tag}`,
          });
          await ctx.interaction.editReply(
            resultEdit(
              "Avatar cleared",
              `Dreamliner will use its default avatar in **${guild.name}** again.`,
              slashResultOptions(ctx, { tone: "success" }),
            ),
          );
        } catch (error) {
          await ctx.interaction.editReply(
            resultEdit(
              "Could not clear avatar",
              apiErrorMessage(error, "Discord rejected clearing the guild avatar."),
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
        }
        return;
      }

      if (group === "nickname") {
        const auth = await requirePluginPermission(ctx, "bot_customisation", "can_nickname");
        if (!auth) return;

        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        if (!me) {
          await ctx.interaction.reply(
            resultReply(
              "Bot member missing",
              "Could not resolve Dreamliner as a member of this server.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        if (!me.permissions.has(PermissionFlagsBits.ChangeNickname)) {
          await ctx.interaction.reply(
            resultReply(
              "Missing permission",
              "Dreamliner needs the **Change Nickname** permission in this server to update its nickname.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        if (sub === "set") {
          const nickname = ctx.interaction.options.getString("nickname", true).trim();
          if (!nickname) {
            await ctx.interaction.reply(
              resultReply(
                "Invalid nickname",
                "Nickname cannot be empty.",
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
            return;
          }
          if (nickname.length > MAX_NICKNAME_LENGTH) {
            await ctx.interaction.reply(
              resultReply(
                "Nickname too long",
                `Nicknames can be at most ${MAX_NICKNAME_LENGTH} characters.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
            return;
          }

          try {
            await guild.members.editMe({
              nick: nickname,
              reason: `Guild nickname set by ${ctx.interaction.user.tag}`,
            });
            await ctx.interaction.reply(
              resultReply(
                "Nickname updated",
                `Dreamliner is now **${nickname}** in this server.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "success" }),
              ),
            );
          } catch (error) {
            await ctx.interaction.reply(
              resultReply(
                "Could not set nickname",
                apiErrorMessage(error, "Discord rejected the nickname change."),
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
          }
          return;
        }

        // clear
        try {
          await guild.members.editMe({
            nick: null,
            reason: `Guild nickname cleared by ${ctx.interaction.user.tag}`,
          });
          await ctx.interaction.reply(
            resultReply(
              "Nickname cleared",
              `Dreamliner will use its default username in **${guild.name}** again.`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success" }),
            ),
          );
        } catch (error) {
          await ctx.interaction.reply(
            resultReply(
              "Could not clear nickname",
              apiErrorMessage(error, "Discord rejected clearing the nickname."),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
        }
      }
    },
  },
];
