import { SlashCommandBuilder, type AutocompleteInteraction, type Message, type TextBasedChannel } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { parseMessageLink } from "../../core/messageLink.js";
import {
  DEFAULT_LANGUAGE_CODE,
  languageChoices,
  normalizeLanguageCode,
} from "../../core/languages.js";
import { buildTranslationPayload } from "./functions/embed.js";
import { translateText } from "./functions/translate.js";

const SNOWFLAKE_RE = /^\d{17,20}$/;

export async function handleTranslateAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "language") {
    await interaction.respond([]);
    return;
  }
  await interaction.respond(languageChoices(String(focused.value ?? "")));
}

async function resolveMessageTarget(
  ctx: import("../../core/types.js").SlashCommandContext,
  raw: string,
): Promise<{ ok: true; message: Message } | { ok: false; title: string; details: string }> {
  const guild = ctx.interaction.guild;
  const guildId = ctx.interaction.guildId;
  if (!guild || !guildId) {
    return { ok: false, title: "Server only", details: "Use this command in a server." };
  }

  const trimmed = raw.trim();
  const link = parseMessageLink(trimmed);

  let channelId: string;
  let messageId: string;

  if (link) {
    if (link.guildId !== guildId) {
      return { ok: false, title: "Wrong server", details: "That message link is from a different server." };
    }
    channelId = link.channelId;
    messageId = link.messageId;
  } else if (SNOWFLAKE_RE.test(trimmed)) {
    const current = ctx.interaction.channel;
    if (!current || !current.isTextBased() || !("messages" in current)) {
      return { ok: false, title: "Channel error", details: "Could not read messages in this channel." };
    }
    channelId = current.id;
    messageId = trimmed;
  } else {
    return {
      ok: false,
      title: "Invalid message",
      details: "Provide a message ID or a Discord message link.",
    };
  }

  let channel: TextBasedChannel | null = null;
  if (ctx.interaction.channelId === channelId && ctx.interaction.channel?.isTextBased()) {
    channel = ctx.interaction.channel;
  } else {
    const fetched = await guild.channels.fetch(channelId).catch(() => null);
    if (fetched?.isTextBased()) channel = fetched;
  }

  if (!channel || !("messages" in channel)) {
    return { ok: false, title: "Not found", details: "Could not find that channel in this server." };
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    return {
      ok: false,
      title: "Not found",
      details: link
        ? "Could not find that message. Check the link and bot permissions."
        : "Could not find that message in this channel.",
    };
  }

  return { ok: true, message };
}

export const translationCommands: SlashCommandDefinition[] = [
  {
    plugin: "translation",
    data: new SlashCommandBuilder()
      .setName("translate")
      .setDescription("Translate text or a message into another language")
      .addStringOption((o) =>
        o.setName("text").setDescription("Text to translate").setMaxLength(2000),
      )
      .addStringOption((o) =>
        o
          .setName("message_id")
          .setDescription("Message ID or message link to translate")
          .setMaxLength(200),
      )
      .addStringOption((o) =>
        o
          .setName("language")
          .setDescription("Target language (default: server language)")
          .setAutocomplete(true),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "translation", "can_translate");
      if (!auth) return;

      const textOpt = ctx.interaction.options.getString("text");
      const messageRaw = ctx.interaction.options.getString("message_id");
      const languageOpt = ctx.interaction.options.getString("language");

      if ((!textOpt && !messageRaw) || (textOpt && messageRaw)) {
        await ctx.interaction.reply(
          resultReply(
            "Invalid input",
            "Provide either `text` or `message_id` (ID or message link), not both.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const target = normalizeLanguageCode(
        languageOpt || ctx.guildConfig.default_language || DEFAULT_LANGUAGE_CODE,
      );

      let sourceText = textOpt?.trim() ?? "";
      let sourceMessage = null as Message | null;

      if (messageRaw) {
        const resolved = await resolveMessageTarget(ctx, messageRaw);
        if (!resolved.ok) {
          await ctx.interaction.reply(
            resultReply(resolved.title, resolved.details, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        sourceMessage = resolved.message;
        sourceText = sourceMessage.content?.trim() ?? "";
        if (!sourceText) {
          await ctx.interaction.reply(
            resultReply(
              "Empty message",
              "That message has no text to translate.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
      }

      if (!sourceText) {
        await ctx.interaction.reply(
          resultReply(
            "Empty text",
            "Provide some text to translate.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });

      try {
        const translated = await translateText(sourceText, target, "auto");
        const payload = buildTranslationPayload(ctx.client, ctx.guildConfig, {
          translated: translated.text,
          from: translated.from,
          to: translated.to,
          author: sourceMessage?.author ?? null,
          sourceMessage,
        });

        await ctx.interaction.editReply(payload);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Translation failed. Try again in a moment.";
        await ctx.interaction.editReply(
          resultEdit("Translation failed", message, slashResultOptions(ctx, { tone: "error" })),
        );
      }
    },
  },
];
