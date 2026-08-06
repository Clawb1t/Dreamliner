import {
  DiscordAPIError,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Attachment,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import {
  deferReplyOptions,
  resultEdit,
  resultReply,
  slashResultOptions,
} from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);
const MAX_NICKNAME_LENGTH = 32;

async function downloadAvatar(attachment: Attachment): Promise<
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; title: string; details: string }
> {
  if (attachment.size > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      title: "File too large",
      details: `Avatar images must be ${MAX_AVATAR_BYTES / (1024 * 1024)}MB or smaller.`,
    };
  }

  const contentType = (attachment.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const looksLikeImage =
    ALLOWED_AVATAR_TYPES.has(contentType) ||
    /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? "");

  if (!looksLikeImage) {
    return {
      ok: false,
      title: "Invalid image",
      details: "Upload a PNG, JPEG, GIF, or WebP image.",
    };
  }

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return {
        ok: false,
        title: "Download failed",
        details: "Could not download that attachment. Try again.",
      };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_AVATAR_BYTES) {
      return {
        ok: false,
        title: "File too large",
        details: `Avatar images must be ${MAX_AVATAR_BYTES / (1024 * 1024)}MB or smaller.`,
      };
    }
    return { ok: true, buffer, contentType: contentType || "image/png" };
  } catch {
    return {
      ok: false,
      title: "Download failed",
      details: "Could not download that attachment. Try again.",
    };
  }
}

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
          const attachment = ctx.interaction.options.getAttachment("image", true);
          await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

          const downloaded = await downloadAvatar(attachment);
          if (!downloaded.ok) {
            await ctx.interaction.editReply(
              resultEdit(downloaded.title, downloaded.details, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }

          try {
            const me = await guild.members.editMe({
              avatar: downloaded.buffer,
              reason: `Guild avatar set by ${ctx.interaction.user.tag}`,
            });
            const avatarUrl = me.displayAvatarURL({ size: 1024 });
            await ctx.interaction.editReply(
              resultEdit(
                "Avatar updated",
                `Dreamliner's avatar for **${guild.name}** is now set.`,
                slashResultOptions(ctx, { tone: "success", imageURL: avatarUrl }),
              ),
            );
          } catch (error) {
            await ctx.interaction.editReply(
              resultEdit(
                "Could not set avatar",
                apiErrorMessage(
                  error,
                  "Discord rejected the avatar change. Per-server bot avatars must be supported for this application.",
                ),
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
          }
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
