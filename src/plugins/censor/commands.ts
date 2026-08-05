import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { contentMatchesPattern } from "../../core/rules.js";
import { addCensorRule, listCensorRules, removeCensorRule } from "./functions/store.js";

export const censorCommands: SlashCommandDefinition[] = [
  {
    plugin: "censor",
    data: new SlashCommandBuilder()
      .setName("censor")
      .setDescription("Manage censor rules")
      .addSubcommand((sub) => sub.setName("list").setDescription("List censor rules"))
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add a censor rule")
          .addStringOption((o) => o.setName("pattern").setDescription("Pattern to match").setRequired(true))
          .addStringOption((o) =>
            o
              .setName("match_type")
              .setDescription("How to match (default: contains)")
              .addChoices({ name: "Contains", value: "contains" }, { name: "Regex", value: "regex" }),
          )
          .addBooleanOption((o) => o.setName("regex").setDescription("Treat pattern as regex (legacy; prefer match_type)"))
          .addStringOption((o) =>
            o
              .setName("action")
              .setDescription("Action when matched")
              .addChoices({ name: "Delete", value: "delete" }, { name: "Warn", value: "warn" }),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a censor rule by ID")
          .addIntegerOption((o) => o.setName("id").setDescription("Rule ID").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("test")
          .setDescription("Test a message against censor rules")
          .addStringOption((o) => o.setName("message").setDescription("Sample message").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "list") {
        const auth = await requirePluginPermission(ctx, "censor", "can_list");
        if (!auth) return;
        const rules = await listCensorRules(guildId);
        if (!rules.length) {
          await ctx.interaction.reply(
            resultReply("Censor rules", "No database rules configured.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const lines = rules.map(
          (r) => `#${r.id} \`${r.pattern}\`${r.regex ? " (regex)" : ""} → **${r.action}**`,
        );
        await ctx.interaction.reply(
          resultReply("Censor rules", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "add") {
        const auth = await requirePluginPermission(ctx, "censor", "can_add");
        if (!auth) return;
        const pattern = ctx.interaction.options.getString("pattern", true);
        const matchType = ctx.interaction.options.getString("match_type");
        const legacyRegex = ctx.interaction.options.getBoolean("regex");
        const regex = matchType === "regex" || legacyRegex === true;
        const action = ctx.interaction.options.getString("action") ?? "delete";

        if (regex) {
          try {
            new RegExp(pattern);
          } catch {
            await ctx.interaction.reply(
              resultReply("Invalid regex", "Provide a valid regular expression.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
            );
            return;
          }
        }

        const rule = await addCensorRule({ guildId, pattern, regex, action });
        await ctx.interaction.reply(
          resultReply(
            "Censor rule added",
            `Rule #${rule.id}: \`${pattern}\`${regex ? " (regex)" : ""} → **${action}**`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "remove") {
        const auth = await requirePluginPermission(ctx, "censor", "can_remove");
        if (!auth) return;
        const id = ctx.interaction.options.getInteger("id", true);
        const removed = await removeCensorRule(guildId, id);
        if (!removed) {
          await ctx.interaction.reply(
            resultReply("Censor", `No rule #${id} found.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        await ctx.interaction.reply(
          resultReply("Censor rule removed", `Rule #${id} deleted.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "test") {
        const auth = await requirePluginPermission(ctx, "censor", "can_list");
        if (!auth) return;
        const message = ctx.interaction.options.getString("message", true);
        const rules = await listCensorRules(guildId);
        const hits = rules.filter((rule) => contentMatchesPattern(message, rule.pattern, rule.regex));
        if (!hits.length) {
          await ctx.interaction.reply(
            resultReply("Censor test", "No rules matched.", ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const lines = hits.map((r) => `#${r.id} \`${r.pattern}\` → **${r.action}**`);
        await ctx.interaction.reply(
          resultReply("Censor test", `Matched:\n${lines.join("\n")}`, ctx.ephemeral, slashResultOptions(ctx)),
        );
      }
    },
  },
];
