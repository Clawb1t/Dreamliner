import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { compileDreamcode, DreamcodeError } from "../../../dreamcode/index.js";
import {
  createDreamCommand,
  deleteDreamCommand,
  getDreamCommand,
  isValidCommandName,
  listDreamCommands,
  normalizeCommandName,
} from "../functions/store.js";

const MAX_SOURCE_BYTES = 32_000;

export const dreamCommandManageCommands: SlashCommandDefinition[] = [
  {
    plugin: "dream_commands",
    data: new SlashCommandBuilder()
      .setName("command")
      .setDescription("Manage custom Dreamcode commands")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a custom command from a Dreamcode file")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Command alias (letters, numbers, underscore; used after the prefix)")
              .setRequired(true),
          )
          .addAttachmentOption((o) =>
            o.setName("code").setDescription("Dreamcode source file (.dream or .txt)").setRequired(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("level")
              .setDescription("Minimum permission level required to run this command (default 0)")
              .setMinValue(0)
              .setMaxValue(9999),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a custom command")
          .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("List custom Dreamcode commands")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_create");
        if (!auth) return;

        const rawName = ctx.interaction.options.getString("name", true);
        const name = normalizeCommandName(rawName);
        const attachment = ctx.interaction.options.getAttachment("code", true);
        const minLevel = ctx.interaction.options.getInteger("level") ?? 0;

        if (!isValidCommandName(name)) {
          await ctx.interaction.reply(
            resultReply(
              "Invalid name",
              "Use 1–32 characters: lowercase letters, numbers, and underscores only.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        const existing = await getDreamCommand(guildId, name);
        if (existing) {
          await ctx.interaction.reply(
            resultReply(
              "Already exists",
              `A command named **${name}** already exists. Remove it first.`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        if (attachment.size > MAX_SOURCE_BYTES) {
          await ctx.interaction.reply(
            resultReply(
              "File too large",
              `Dreamcode files must be under ${MAX_SOURCE_BYTES} bytes.`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        let source: string;
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          source = await res.text();
        } catch {
          await ctx.interaction.reply(
            resultReply(
              "Download failed",
              "Could not download the attached Dreamcode file.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        source = source.replace(/^\uFEFF/, "");
        if (!source.trim()) {
          await ctx.interaction.reply(
            resultReply("Empty file", "The Dreamcode file is empty.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        try {
          compileDreamcode(source);
        } catch (err) {
          const message = err instanceof DreamcodeError ? err.message : "Invalid Dreamcode.";
          await ctx.interaction.reply(
            resultReply("Invalid Dreamcode", message, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await createDreamCommand({
          guildId,
          name,
          source,
          minLevel,
          createdBy: ctx.interaction.user.id,
        });

        const prefix =
          typeof ctx.pluginConfig.prefix === "string" && ctx.pluginConfig.prefix.length > 0
            ? ctx.pluginConfig.prefix
            : "d!";

        await ctx.interaction.reply(
          resultReply(
            "Command created",
            `Saved **${name}** (min level **${minLevel}**). Trigger with \`${prefix}${name}\`.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_remove");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteDreamCommand(guildId, name);
        await ctx.interaction.reply(
          resultReply(
            deleted ? "Command removed" : "Not found",
            deleted ? `Removed **${normalizeCommandName(name)}**.` : `No command named **${name}**.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_list");
        if (!auth) return;

        const rows = await listDreamCommands(guildId);
        if (!rows.length) {
          await ctx.interaction.reply(
            resultReply("Commands", "No custom Dreamcode commands configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        const prefix =
          typeof ctx.pluginConfig.prefix === "string" && ctx.pluginConfig.prefix.length > 0
            ? ctx.pluginConfig.prefix
            : "d!";

        const lines = rows
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => {
            const preview = row.source.trim().split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
            const short = preview.length > 60 ? `${preview.slice(0, 57)}…` : preview;
            return `**${prefix}${row.name}** · level ≥ **${row.minLevel}**${short ? `\n\`${short}\`` : ""}`;
          });

        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Dreamcode commands", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("Commands", trimLines(lines.join("\n\n"))),
            ),
            ctx.ephemeral,
          ),
        );
      }
    },
  },
];
