import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { compileDreamcode, DreamcodeError, type Program } from "../../../dreamcode/index.js";
import {
  countSlashDreamCommands,
  createDreamCommand,
  deleteDreamCommand,
  getDreamCommand,
  isValidCommandName,
  listDreamCommands,
  MAX_SLASH_DREAM_COMMANDS,
  normalizeCommandName,
  updateDreamCommandSource,
  type DreamTriggerType,
} from "../functions/store.js";
import { DREAM_SLASH_CAP, isReservedCommandName, syncGuildDreamSlashCommands } from "../functions/guildSlash.js";
import { formatTriggerLabel, getDreamPrefix } from "../functions/run.js";

const MAX_SOURCE_BYTES = 32_000;

type DownloadedSource =
  | { ok: true; source: string; program: Program }
  | { ok: false; title: string; description: string };

async function downloadAttachmentSource(attachment: {
  url: string;
  size: number;
}): Promise<DownloadedSource> {
  if (attachment.size > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      title: "File too large",
      description: `Dreamcode files must be under ${MAX_SOURCE_BYTES} bytes.`,
    };
  }
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let source = (await res.text()).replace(/^\uFEFF/, "");
    if (!source.trim()) {
      return { ok: false, title: "Empty file", description: "The Dreamcode file is empty." };
    }
    try {
      const program = compileDreamcode(source);
      if (!program.trigger) {
        return {
          ok: false,
          title: "Missing trigger",
          description:
            "Add `@prefix` or `@slash` at the top of the file to declare how the command is triggered.",
        };
      }
      return { ok: true, source, program };
    } catch (err) {
      const message = err instanceof DreamcodeError ? err.message : "Invalid Dreamcode.";
      return { ok: false, title: "Invalid Dreamcode", description: message };
    }
  } catch {
    return {
      ok: false,
      title: "Download failed",
      description: "Could not download the attached Dreamcode file.",
    };
  }
}

function listStatRow(total: number, slashCount: number, prefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("dl:dreamcmd:stat:total")
      .setLabel(`${total} total`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("dl:dreamcmd:stat:slash")
      .setLabel(`${slashCount}/${MAX_SLASH_DREAM_COMMANDS} slash`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("dl:dreamcmd:stat:prefix")
      .setLabel(`prefix ${prefix}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

export const dreamCommandManageCommands: SlashCommandDefinition[] = [
  {
    plugin: "dream_commands",
    data: new SlashCommandBuilder()
      .setName("command")
      .setDescription("Manage custom Dreamcode commands")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Create a custom Dreamcode command")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Command name (letters, numbers, underscore)")
              .setRequired(true),
          )
          .addAttachmentOption((o) =>
            o.setName("code").setDescription("Dreamcode source file (.dream or .txt)").setRequired(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("level")
              .setDescription("Minimum permission level required to run (default 0)")
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
      .addSubcommand((sub) => sub.setName("list").setDescription("List custom Dreamcode commands"))
      .addSubcommandGroup((group) =>
        group
          .setName("edit")
          .setDescription("Edit an existing Dreamcode command")
          .addSubcommand((sub) =>
            sub
              .setName("download")
              .setDescription("Download the Dreamcode source for a command")
              .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true)),
          )
          .addSubcommand((sub) =>
            sub
              .setName("upload")
              .setDescription("Upload new Dreamcode source for a command")
              .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true))
              .addAttachmentOption((o) =>
                o.setName("code").setDescription("New Dreamcode source file").setRequired(true),
              ),
          ),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const prefix = getDreamPrefix(ctx.pluginConfig);

      if (group === "edit") {
        if (sub === "download") {
          const auth = await requirePluginPermission(ctx, "dream_commands", "can_edit");
          if (!auth) return;

          const name = normalizeCommandName(ctx.interaction.options.getString("name", true));
          const command = await getDreamCommand(guildId, name);
          if (!command) {
            await ctx.interaction.reply(
              resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
            );
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(command.source, "utf-8"), {
            name: `${command.name}.dream`,
          });
          await ctx.interaction.reply({
            ...resultReply(
              "Command source",
              trimLines(`
                **${command.name}**
                Type: **${command.triggerType}**
                Trigger: \`${formatTriggerLabel(command, prefix)}\`
                Min level: **${command.minLevel}**
              `),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
            files: [file],
          });
          return;
        }

        if (sub === "upload") {
          const auth = await requirePluginPermission(ctx, "dream_commands", "can_edit");
          if (!auth) return;

          const name = normalizeCommandName(ctx.interaction.options.getString("name", true));
          const existing = await getDreamCommand(guildId, name);
          if (!existing) {
            await ctx.interaction.reply(
              resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
            );
            return;
          }

          const attachment = ctx.interaction.options.getAttachment("code", true);
          const downloaded = await downloadAttachmentSource(attachment);
          if (!downloaded.ok) {
            await ctx.interaction.reply(
              resultReply(downloaded.title, downloaded.description, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }

          const triggerType = downloaded.program.trigger as DreamTriggerType;
          const wasSlash = existing.triggerType === "slash";
          const willBeSlash = triggerType === "slash";

          if (isReservedCommandName(name)) {
            await ctx.interaction.reply(
              resultReply(
                "Reserved name",
                `**${name}** is reserved by a built-in Dreamliner command (e.g. \`/${name}\` / \`${prefix}${name}\`). Rename the command instead.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "error" }),
              ),
            );
            return;
          }

          if (willBeSlash && !wasSlash) {
            const slashCount = await countSlashDreamCommands(guildId);
            if (slashCount >= MAX_SLASH_DREAM_COMMANDS) {
              await ctx.interaction.reply(
                resultReply(
                  "Slash limit reached",
                  `This server already has **${MAX_SLASH_DREAM_COMMANDS}** slash Dreamcode commands (max ${DREAM_SLASH_CAP}).`,
                  ctx.ephemeral,
                  slashResultOptions(ctx, { tone: "warning" }),
                ),
              );
              return;
            }
          }

          const updated = await updateDreamCommandSource(guildId, name, downloaded.source, triggerType);
          if (!updated) {
            await ctx.interaction.reply(
              resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
            );
            return;
          }

          if (wasSlash || willBeSlash) {
            try {
              await syncGuildDreamSlashCommands(ctx.client, guildId);
            } catch (error) {
              console.error("[dream_commands] guild slash sync failed after edit:", error);
              await ctx.interaction.reply(
                resultReply(
                  "Command updated",
                  `Updated source for **${name}**, but Discord guild slash sync failed. Restart the bot or re-upload to retry.`,
                  ctx.ephemeral,
                  slashResultOptions(ctx, { tone: "warning" }),
                ),
              );
              return;
            }
          }

          await ctx.interaction.reply(
            resultReply(
              "Command updated",
              `Updated **${name}** (\`${formatTriggerLabel(updated, prefix)}\`).`,
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }
      }

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

        if (isReservedCommandName(name)) {
          await ctx.interaction.reply(
            resultReply(
              "Reserved name",
              `**${name}** is reserved by a built-in Dreamliner command. You cannot create \`${prefix}${name}\` or \`/${name}\` as a Dreamcode command.`,
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
              `A command named **${name}** already exists (\`${formatTriggerLabel(existing, prefix)}\`).`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        const downloaded = await downloadAttachmentSource(attachment);
        if (!downloaded.ok) {
          await ctx.interaction.reply(
            resultReply(downloaded.title, downloaded.description, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const triggerType = downloaded.program.trigger as DreamTriggerType;

        if (triggerType === "slash") {
          const slashCount = await countSlashDreamCommands(guildId);
          if (slashCount >= MAX_SLASH_DREAM_COMMANDS) {
            await ctx.interaction.reply(
              resultReply(
                "Slash limit reached",
                `This server already has **${MAX_SLASH_DREAM_COMMANDS}** slash Dreamcode commands (max ${DREAM_SLASH_CAP}). Remove one or use \`@prefix\`.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "warning" }),
              ),
            );
            return;
          }
        }

        const created = await createDreamCommand({
          guildId,
          name,
          source: downloaded.source,
          triggerType,
          minLevel,
          createdBy: ctx.interaction.user.id,
        });

        if (triggerType === "slash") {
          try {
            await syncGuildDreamSlashCommands(ctx.client, guildId);
          } catch (error) {
            console.error("[dream_commands] guild slash sync failed after create:", error);
            await ctx.interaction.reply(
              resultReply(
                "Created, sync failed",
                `Saved **${name}**, but Discord guild slash sync failed. Try removing and recreating, or restart the bot.`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "warning" }),
              ),
            );
            return;
          }
        }

        const trigger = formatTriggerLabel(created, prefix);
        await ctx.interaction.reply(
          resultReply(
            "Command created",
            trimLines(`
              Saved **${name}**
              Type: **${triggerType}**
              Trigger: \`${trigger}\`
              Min level: **${minLevel}**
            `),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "dream_commands", "can_remove");
        if (!auth) return;

        const name = ctx.interaction.options.getString("name", true);
        const deleted = await deleteDreamCommand(guildId, name);
        if (!deleted) {
          await ctx.interaction.reply(
            resultReply("Not found", `No command named **${name}**.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }

        if (deleted.triggerType === "slash") {
          try {
            await syncGuildDreamSlashCommands(ctx.client, guildId);
          } catch (error) {
            console.error("[dream_commands] guild slash sync failed after remove:", error);
          }
        }

        await ctx.interaction.reply(
          resultReply(
            "Command removed",
            `Removed **${deleted.name}** (\`${formatTriggerLabel(deleted, prefix)}\`).`,
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

        const guildSlashIds = new Map<string, string>();
        try {
          const guildCmds = await ctx.interaction.guild!.commands.fetch();
          for (const cmd of guildCmds.values()) {
            guildSlashIds.set(cmd.name, cmd.id);
          }
        } catch (error) {
          console.warn("[dream_commands] failed to fetch guild slash ids for list:", error);
        }

        const slashCount = rows.filter((r) => r.triggerType === "slash").length;
        const lines = rows
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((row) => {
            let trigger: string;
            if (row.triggerType === "slash") {
              const id = guildSlashIds.get(row.name);
              trigger = id ? `</${row.name}:${id}>` : `\`/${row.name}\``;
            } else {
              trigger = `\`${prefix}${row.name}\``;
            }
            return `**${row.name}** · ${trigger}\n> Level **${row.minLevel}**`;
          });

        const embed = setEmbedAuthor(
          baseEmbed(),
          "Dreamcode commands",
          ctx.client,
          commandHeader(ctx.guildConfig),
        ).setDescription(trimLines(lines.join("\n\n")));

        await ctx.interaction.reply({
          ...embedReply(embed, ctx.ephemeral),
          components: [listStatRow(rows.length, slashCount, prefix)],
        });
      }
    },
  },
];
