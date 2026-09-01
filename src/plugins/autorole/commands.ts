import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { zAutoroleConfig } from "../../config/schemas/autorole.js";
import { buildAutoroleAddModal } from "./functions/modal.js";
import {
  formatAutoroleAudience,
  formatAutoroleEntry,
  getStoredAutoroleEntries,
  parseAutoroleAudience,
  patchForAudience,
} from "./functions/rules.js";

export const autoroleCommands: SlashCommandDefinition[] = [
  {
    plugin: "autorole",
    data: new SlashCommandBuilder()
      .setName("autorole")
      .setDescription("Configure roles assigned when members or bots join")
      .addSubcommand((sub) => sub.setName("add").setDescription("Open a form to add an autorole"))
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a role from an autorole list")
          .addRoleOption((o) =>
            o.setName("role").setDescription("Role to stop assigning on join").setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName("for")
              .setDescription("Which list to remove from (default: humans)")
              .addChoices(
                { name: "Humans", value: "humans" },
                { name: "Bots", value: "bots" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List configured autoroles")
          .addStringOption((o) =>
            o
              .setName("for")
              .setDescription("Which list to show (default: both)")
              .addChoices(
                { name: "Both", value: "both" },
                { name: "Humans", value: "humans" },
                { name: "Bots", value: "bots" },
              ),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_add");
        if (!auth) return;

        await ctx.interaction.showModal(buildAutoroleAddModal());
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_remove");
        if (!auth) return;

        const role = ctx.interaction.options.getRole("role", true);
        const audience = parseAutoroleAudience(ctx.interaction.options.getString("for"));
        const config = zAutoroleConfig.parse(auth.pluginConfig);
        const entries = getStoredAutoroleEntries(config, audience);
        const filtered = entries.filter((entry) => entry.roleId !== role.id);

        if (filtered.length === entries.length) {
          await ctx.interaction.reply(
            resultReply(
              "Not found",
              `<@&${role.id}> is not in the ${formatAutoroleAudience(audience)} autorole list.`,
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const result = await ctx.configManager.patchPluginConfig(
          guildId,
          "autorole",
          patchForAudience(audience, filtered),
          ctx.interaction.user.id,
        );
        if (!result.success) {
          await ctx.interaction.reply(
            resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        await ctx.interaction.reply(
          resultReply(
            "Autorole removed",
            `Removed <@&${role.id}> from the ${formatAutoroleAudience(audience)} autorole list.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_off:1544417567777628201>" }),
          ),
        );
        return;
      }

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "autorole", "can_list");
        if (!auth) return;

        const filter = ctx.interaction.options.getString("for") ?? "both";
        const config = zAutoroleConfig.parse(auth.pluginConfig);
        const humanEntries = getStoredAutoroleEntries(config, "humans");
        const botEntries = getStoredAutoroleEntries(config, "bots");

        const showHumans = filter === "both" || filter === "humans";
        const showBots = filter === "both" || filter === "bots";

        if ((showHumans ? humanEntries.length : 0) + (showBots ? botEntries.length : 0) === 0) {
          await ctx.interaction.reply(
            resultReply(
              "Autoroles",
              filter === "both"
                ? "No autoroles configured for humans or bots."
                : `No autoroles configured for ${formatAutoroleAudience(parseAutoroleAudience(filter))}.`,
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const embed = setEmbedAuthor(
          baseEmbed(),
          "Autoroles",
          ctx.client,
          commandHeader(ctx.guildConfig, { emoji: "<:icons_list:1544417562325164173>" }),
        );
        if (showHumans) {
          embed.addFields(
            embedField(
              "Humans",
              humanEntries.length
                ? trimLines(humanEntries.map((entry) => formatAutoroleEntry(entry.roleId, entry)).join("\n"))
                : "None",
            ),
          );
        }
        if (showBots) {
          embed.addFields(
            embedField(
              "Bots",
              botEntries.length
                ? trimLines(botEntries.map((entry) => formatAutoroleEntry(entry.roleId, entry)).join("\n"))
                : "None",
            ),
          );
        }

        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
      }
    },
  },
];
