import {
  ApplicationCommandType,
  AttachmentBuilder,
  ContextMenuCommandBuilder,
  MessageFlags,
  StickerFormatType,
  type TextChannel,
} from "discord.js";
import { resolveEmojiForContent } from "../../../core/emoji.js";
import type { ContextMenuCommandDefinition } from "../../../core/types.js";
import { convertAttachmentToGif } from "../functions/convertToGif.js";
import { replyContextMenuError } from "../functions/contextMenuHelpers.js";
import { downloadUrl, getImageAttachments } from "../functions/imageAttachments.js";
import { normalizeSticker } from "../functions/normalizeSticker.js";
import { normalizeEmoji } from "../functions/normalizeEmoji.js";
import { ManageGuildExpressions, ManageMessages } from "../functions/commandHelpers.js";
import { archiveMessages, collectMessagesToHere, formatArchiveTranscript, serializeMessages } from "../functions/clean.js";
import { DiscofySubmitError, submitDiscofyQuote } from "../functions/discofy.js";
import { embedWithFilesEdit, resultEdit, guildResultOptions } from "../../../core/responses.js";
import { buildResultEmbed } from "../../../core/embeds.js";
import { buildCleanLog } from "../../../core/logging/format.js";
import { sendModerationLog } from "../../../core/logging/send.js";
import { getLogger } from "../../../core/logger.js";
const log = getLogger("utility");

const MAX_GIF_ATTACHMENTS = 10;
const DISCOFY_EMOJI = "<:discofy:1548639182358978620>";

/** Discord sticker names: 2-30 characters, letters/numbers/underscores/dashes/spaces. */
function sanitizeStickerName(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_\- ]/g, "").trim().slice(0, 30);
  return cleaned.length >= 2 ? cleaned : null;
}

/** Discord custom emoji names: 2-32 characters, letters/numbers/underscores only. */
function sanitizeEmojiName(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
  return cleaned.length >= 2 ? cleaned : null;
}

/** First custom emoji anywhere in a message's text, not anchored to the whole string (unlike
 * /stealemoji's exact-match regex, since here it's found inside free-form message content). */
const CONTENT_EMOJI_RE = /<(a?):(\w{2,32}):(\d+)>/;

export const contextMenuCommands: ContextMenuCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_convert_gif",
    data: new ContextMenuCommandBuilder()
      .setName("Convert to GIF")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction, client } = ctx;
      await interaction.deferReply();

      const imageAttachments = getImageAttachments(interaction.targetMessage.attachments);
      if (imageAttachments.length === 0) {
        await replyContextMenuError(ctx, "No images", "That message has no image attachments.");
        return;
      }

      const toConvert = imageAttachments.slice(0, MAX_GIF_ATTACHMENTS);
      try {
        const files = await Promise.all(
          toConvert.map((attachment, index) => convertAttachmentToGif(attachment, index)),
        );

        const gifEmoji = resolveEmojiForContent("<:icons_gif:1544417549347848232>", client);
        await interaction.editReply({
          content: `${gifEmoji} Hover over the GIF and click the favorite button to add it to your favorites.`,
          files,
        });
      } catch (error) {
        log.error("Convert to GIF error:", error);
        await replyContextMenuError(ctx, "Conversion failed", "Could not convert those images to GIFs.");
      }
    },
  },
  {
    plugin: "utility",
    // Same gate as /clean — a Dreamliner Role needs the same "can_clean" grant, plus the real
    // Discord Manage Messages permission, to bulk-delete with either one.
    permission: "can_clean",
    discordPermissions: ManageMessages,
    data: new ContextMenuCommandBuilder()
      .setName("Clean to here")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const channel = interaction.channel;
      if (!channel?.isTextBased() || channel.isDMBased() || !("bulkDelete" in channel)) {
        await replyContextMenuError(ctx, "Clean to here", "This command must be used in a text channel.");
        return;
      }
      const textChannel = channel as TextChannel;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await collectMessagesToHere(textChannel, interaction.targetMessage.id);
      if (!result || result.messages.size === 0) {
        await interaction.editReply(
          resultEdit("Clean to here", "No messages to delete.", guildResultOptions(ctx.client, ctx.guildConfig)),
        );
        return;
      }

      const serialized = serializeMessages([...result.messages.values()]);
      const archiveId = await archiveMessages(interaction.guildId!, serialized);
      const archiveFilename = `clean-${archiveId}.txt`;
      const transcript = formatArchiveTranscript(serialized);

      let count: number;
      if (result.messages.size === 1) {
        // bulkDelete requires 2+ messages — a lone target with nothing after it just gets a
        // normal delete instead.
        const [only] = result.messages.values();
        const deleted = await only?.delete().catch(() => null);
        count = deleted ? 1 : 0;
      } else {
        const deleted = await textChannel.bulkDelete(result.messages, true).catch(() => null);
        count = deleted?.size ?? 0;
      }

      await sendModerationLog(
        ctx.client,
        ctx.guildConfig,
        buildCleanLog({
          mod: {
            id: interaction.user.id,
            name: interaction.user.username,
            avatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
          },
          channel: { id: textChannel.id, name: textChannel.name },
          count,
          archiveId,
          archiveFile: { name: archiveFilename, content: transcript },
        }),
        {
          guildId: interaction.guildId!,
          eventType: "clean",
          actorId: interaction.user.id,
          channelId: textChannel.id,
        },
      );

      const note = result.truncated
        ? " There were more than 100 messages up to here — only the most recent 100 were cleared; run it again for the rest."
        : "";
      await interaction.editReply(
        embedWithFilesEdit(
          buildResultEmbed(
            "Clean to here",
            `Deleted **${count}** message(s) up to and including the target (archive \`${archiveId}\`) — full content attached.${note}`,
            guildResultOptions(ctx.client, ctx.guildConfig, { emoji: "<:icons_clean:1544417689320034304>" }),
          ),
          [new AttachmentBuilder(Buffer.from(transcript, "utf-8"), { name: archiveFilename })],
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_create_sticker",
    discordPermissions: ManageGuildExpressions,
    data: new ContextMenuCommandBuilder()
      .setName("Create Sticker")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const guild = interaction.guild!;
      const message = interaction.targetMessage;

      // Stealing an existing sticker takes priority over an image attachment — a message
      // with a sticker on it has no other useful image to fall back to anyway.
      const sourceSticker = message.stickers.first();
      if (sourceSticker) {
        if (sourceSticker.format === StickerFormatType.Lottie) {
          await replyContextMenuError(
            ctx,
            "Can't copy that sticker",
            "That's an animated (Lottie) sticker — Dreamliner can only copy image-based stickers.",
          );
          return;
        }

        await interaction.deferReply();
        try {
          const buffer = await downloadUrl(sourceSticker.url);
          const name = sanitizeStickerName(sourceSticker.name) ?? `sticker_${sourceSticker.id}`;
          const created = await guild.stickers.create({
            file: buffer,
            name,
            tags: sourceSticker.tags?.trim().slice(0, 200) || name,
            description: sourceSticker.description,
          });
          await interaction.editReply(
            resultEdit(
              "Sticker stolen",
              `Added **${created.name}** to this server's stickers.`,
              guildResultOptions(ctx.client, ctx.guildConfig, { emoji: "<:icons_upload2:1544418267412570193>" }),
            ),
          );
        } catch (error) {
          log.error("Create Sticker (steal sticker) error:", error);
          await replyContextMenuError(
            ctx,
            "Couldn't create sticker",
            "Dreamliner may be missing the Manage Expressions permission, or this server already has the maximum number of stickers.",
          );
        }
        return;
      }

      const imageAttachments = getImageAttachments(message.attachments);
      const attachment = imageAttachments[0];
      if (!attachment) {
        await replyContextMenuError(
          ctx,
          "No image or sticker",
          "That message has no image attachment or sticker to turn into a sticker.",
        );
        return;
      }

      await interaction.deferReply();
      try {
        const raw = await downloadUrl(attachment.url);
        const normalized = await normalizeSticker(raw);
        if (!normalized.ok) {
          await replyContextMenuError(ctx, normalized.title, normalized.details);
          return;
        }

        const fromName = attachment.name?.replace(/\.[a-z0-9]+$/i, "");
        const name = sanitizeStickerName(fromName) ?? `sticker_${message.id}`;
        const created = await guild.stickers.create({
          file: normalized.buffer,
          name,
          tags: name,
        });
        await interaction.editReply(
          resultEdit(
            "Sticker created",
            `Added **${created.name}** to this server's stickers.`,
            guildResultOptions(ctx.client, ctx.guildConfig, { emoji: "<:icons_upload2:1544418267412570193>" }),
          ),
        );
      } catch (error) {
        log.error("Create Sticker (from image) error:", error);
        await replyContextMenuError(
          ctx,
          "Couldn't create sticker",
          "Dreamliner may be missing the Manage Expressions permission, or this server already has the maximum number of stickers.",
        );
      }
    },
  },
  {
    plugin: "utility",
    permission: "can_create_emoji",
    discordPermissions: ManageGuildExpressions,
    data: new ContextMenuCommandBuilder()
      .setName("Create Emoji")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const guild = interaction.guild!;
      const message = interaction.targetMessage;

      // Stealing an existing custom emoji from the message's text takes priority over an
      // image attachment — the first one found in the content is the one that gets copied.
      const sourceMatch = CONTENT_EMOJI_RE.exec(message.content ?? "");
      if (sourceMatch) {
        const animated = sourceMatch[1] === "a";
        const sourceName = sourceMatch[2];
        const id = sourceMatch[3];

        await interaction.deferReply();
        try {
          const name = sanitizeEmojiName(sourceName) ?? `emoji_${id}`;
          const ext = animated ? "gif" : "png";
          const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=128&quality=lossless`;
          const created = await guild.emojis.create({ attachment: url, name });
          await interaction.editReply(
            resultEdit(
              "Emoji stolen",
              `Added ${created} as \`:${created.name}:\` to this server.`,
              guildResultOptions(ctx.client, ctx.guildConfig, { emoji: "<:icons_upload2:1544418267412570193>" }),
            ),
          );
        } catch (error) {
          log.error("Create Emoji (steal emoji) error:", error);
          await replyContextMenuError(
            ctx,
            "Couldn't create emoji",
            "Dreamliner may be missing the Manage Expressions permission, or this server already has the maximum number of emoji slots for that type.",
          );
        }
        return;
      }

      const imageAttachments = getImageAttachments(message.attachments);
      const attachment = imageAttachments[0];
      if (!attachment) {
        await replyContextMenuError(
          ctx,
          "No image or emoji",
          "That message has no image attachment or custom emoji to turn into an emoji.",
        );
        return;
      }

      await interaction.deferReply();
      try {
        const raw = await downloadUrl(attachment.url);
        const normalized = await normalizeEmoji(raw);
        if (!normalized.ok) {
          await replyContextMenuError(ctx, normalized.title, normalized.details);
          return;
        }

        const fromName = attachment.name?.replace(/\.[a-z0-9]+$/i, "");
        const name = sanitizeEmojiName(fromName) ?? `emoji_${message.id}`;
        const created = await guild.emojis.create({ attachment: normalized.buffer, name });
        await interaction.editReply(
          resultEdit(
            "Emoji created",
            `Added ${created} as \`:${created.name}:\` to this server.`,
            guildResultOptions(ctx.client, ctx.guildConfig, { emoji: "<:icons_upload2:1544418267412570193>" }),
          ),
        );
      } catch (error) {
        log.error("Create Emoji (from image) error:", error);
        await replyContextMenuError(
          ctx,
          "Couldn't create emoji",
          "Dreamliner may be missing the Manage Expressions permission, or this server already has the maximum number of emoji slots for that type.",
        );
      }
    },
  },
  {
    plugin: "utility",
    permission: "can_quote_to_discofy",
    data: new ContextMenuCommandBuilder()
      .setName("Quote to Discofy")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const message = interaction.targetMessage;

      const content = message.content?.trim();
      if (!content) {
        await replyContextMenuError(ctx, "Nothing to quote", "That message has no text content to quote.");
        return;
      }

      const mediaUrl = getImageAttachments(message.attachments)[0]?.url;

      await interaction.deferReply();
      try {
        const url = await submitDiscofyQuote({
          content,
          quotedByDiscordId: interaction.user.id,
          quotedByUsername: interaction.user.username,
          quotedByAvatarUrl: interaction.user.displayAvatarURL({ size: 128 }),
          quoteeDiscordId: message.author.id,
          quoteeUsername: message.author.username,
          quoteeAvatarUrl: message.author.displayAvatarURL({ size: 128 }),
          mediaUrl,
        }, ctx.t);
        await interaction.editReply(
          resultEdit(
            "Quoted to Discofy",
            `Added to the Discofy feed: ${url}`,
            guildResultOptions(ctx.client, ctx.guildConfig, { emoji: DISCOFY_EMOJI }),
          ),
        );
      } catch (error) {
        log.error("Quote to Discofy error:", error);
        const details = error instanceof DiscofySubmitError ? error.message : "Could not submit that quote to Discofy.";
        await replyContextMenuError(ctx, "Couldn't quote to Discofy", details);
      }
    },
  },
];
