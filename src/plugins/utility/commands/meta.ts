import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, embedReply, embedEdit, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { baseEmbed, buildPingEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { requireUtilityPermission } from "../functions/commandHelpers.js";
import { buildHelpMessage } from "../functions/help.js";
import { formatDuration } from "../../../core/datetime.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const startTime = Date.now();
const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.1.0";
  }
}

export const metaCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_ping",
    data: new SlashCommandBuilder().setName("ping").setDescription("Test bot latency"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_ping");
      if (!auth) return;
      const sent = Date.now();
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      const roundtrip = Date.now() - sent;
      const ws = ctx.interaction.client.ws.ping;
      await ctx.interaction.editReply(embedEdit(buildPingEmbed(roundtrip, ws, ctx.client, ctx.guildConfig.emojis)));
    },
  },
  {
    plugin: "utility",
    permission: "can_about",
    data: new SlashCommandBuilder().setName("about").setDescription("About Dreamliner"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_about");
      if (!auth) return;
      const uptime = formatDuration(Date.now() - startTime);
      const docsUrl = process.env.DOCS_BASE_URL ?? "https://github.com/your-org/dreamliner/blob/main/docs";
      const plugins = [
        "config", "utility", "infractions", "logs", "automod", "censor", "roles",
        "welcome_message", "tags", "reminders", "stats", "autorole", "starboard",
      ];
      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(baseEmbed(), "About", ctx.client, { emojis: ctx.guildConfig.emojis, tone: "neutral" })
            .addFields(
              embedField(
                "Bot information",
                trimLines(`
                  Version: **${getVersion()}**
                  Uptime: **${uptime}**
                  Plugins: **${plugins.join(", ")}**
                `),
              ),
              embedField("Documentation", docsUrl),
            ),
          ctx.ephemeral,
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_help",
    data: new SlashCommandBuilder()
      .setName("help")
      .setDescription("Search available commands")
      .addStringOption((o) => o.setName("query").setDescription("Search term")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_help");
      if (!auth) return;
      const query = (ctx.interaction.options.getString("query") ?? "").trim();
      const docsUrl = process.env.DOCS_BASE_URL ?? "https://github.com/your-org/dreamliner/blob/main/docs";
      await ctx.interaction.reply(buildHelpMessage(0, query, docsUrl, ctx.ephemeral, ctx.client, ctx.guildConfig.emojis));
    },
  },
  {
    plugin: "utility",
    permission: "can_reload_guild",
    data: new SlashCommandBuilder().setName("reload").setDescription("Reload this server's configuration"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_reload_guild");
      if (!auth) return;
      const config = await ctx.configManager.reloadGuild(ctx.interaction.guildId!);
      if (!config) {
        await ctx.interaction.reply(resultReply("Reload", "No custom config stored; using defaults.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
        return;
      }
      await ctx.interaction.reply(resultReply("Reload", "Guild configuration reloaded.", ctx.ephemeral, slashResultOptions(ctx)));
    },
  },
  {
    plugin: "utility",
    permission: "can_avatar",
    data: new SlashCommandBuilder()
      .setName("avatar")
      .setDescription("Show a user's avatar")
      .addUserOption((o) => o.setName("user").setDescription("User")),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_avatar");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
      const url = user.displayAvatarURL({ size: 2048, extension: "png" });
      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(baseEmbed(), "Avatar", ctx.client, commandHeader(ctx.guildConfig))
            .addFields(embedField("User", `<@${user.id}>`))
            .setImage(url),
          ctx.ephemeral,
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_time",
    data: new SlashCommandBuilder()
      .setName("time")
      .setDescription("Show the current time in a timezone")
      .addStringOption((o) =>
        o
          .setName("timezone")
          .setDescription("IANA timezone (default: UTC)")
          .setRequired(false),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_time");
      if (!auth) return;

      const timezone = ctx.interaction.options.getString("timezone")?.trim() || "UTC";
      let formatted: string;
      try {
        formatted = new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(new Date());
      } catch {
        await ctx.interaction.reply(
          resultReply("Time", "Invalid timezone. Use an IANA name like `America/New_York` or `Europe/London`.", ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(baseEmbed(), "Time", ctx.client, commandHeader(ctx.guildConfig)).addFields(
            embedField("Timezone", timezone),
            embedField("Now", formatted),
          ),
          ctx.ephemeral,
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_jumbo",
    data: new SlashCommandBuilder()
      .setName("jumbo")
      .setDescription("Enlarge an emoji")
      .addStringOption((o) => o.setName("emoji").setDescription("Emoji to enlarge").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_jumbo");
      if (!auth) return;
      const input = ctx.interaction.options.getString("emoji", true);
      const size = Number(auth.pluginConfig.jumbo_size ?? 128);
      const customMatch = input.match(/<a?:(\w+):(\d+)>/);
      if (customMatch) {
        const animated = input.startsWith("<a:");
        const name = customMatch[1];
        const id = customMatch[2];
        const ext = animated ? "gif" : "png";
        const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=${Math.min(size, 2048)}`;
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), `Emoji: ${name}`, ctx.client, commandHeader(ctx.guildConfig))
              .setImage(url),
            ctx.ephemeral,
          ),
        );
        return;
      }
      await ctx.interaction.reply(resultReply("Jumbo", "Only custom server emojis can be jumbo'd.", ctx.ephemeral, slashResultOptions(ctx)));
    },
  },
];
