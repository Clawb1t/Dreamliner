import { DiscordAPIError, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resolveDocsUrl } from "../../../core/docsUrl.js";
import {
  resultReply,
  resultEdit,
  embedReply,
  embedEdit,
  slashResultOptions,
  deferReplyOptions,
} from "../../../core/responses.js";
import { baseEmbed, buildPingEmbed, commandHeader, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import {
  ManageGuildExpressions,
  requireDiscordPerm,
  requireUtilityPermission,
} from "../functions/commandHelpers.js";
import { aboutLinkRows, buildAboutEmbed } from "../functions/about.js";
import { buildHelpMessage } from "../functions/help.js";

const CUSTOM_EMOJI_RE = /^<(a?):(\w{2,32}):(\d+)>$/;

function sanitizeEmojiName(raw: string): string | null {
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
  return cleaned.length >= 2 ? cleaned : null;
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
      await ctx.interaction.reply({
        ...embedReply(buildAboutEmbed(ctx.client), ctx.ephemeral),
        components: aboutLinkRows(),
      });
    },
  },
  {
    plugin: "utility",
    permission: "can_help",
    data: new SlashCommandBuilder()
      .setName("help")
      .setDescription("Browse or search bot commands")
      .addStringOption((o) =>
        o.setName("query").setDescription("Optional search (e.g. ban, welcome, role)"),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_help");
      if (!auth) return;
      const query = (ctx.interaction.options.getString("query") ?? "").trim();
      const docsUrl = resolveDocsUrl();
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
  {
    plugin: "utility",
    permission: "can_stealemoji",
    data: new SlashCommandBuilder()
      .setName("stealemoji")
      .setDescription("Copy a custom emoji from another server into this one")
      .addStringOption((o) =>
        o
          .setName("emoji")
          .setDescription("Custom emoji to steal (paste it, even from another server)")
          .setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("name").setDescription("Optional new name (2-32 letters, numbers, underscores)"),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_stealemoji");
      if (!auth) return;

      if (
        !(await requireDiscordPerm(
          ctx.interaction,
          ManageGuildExpressions,
          "Manage Expressions",
          ctx.ephemeral,
          ctx.guildConfig,
        ))
      ) {
        return;
      }

      const guild = ctx.interaction.guild!;
      const me = guild.members.me;
      if (!me?.permissions.has(ManageGuildExpressions)) {
        await ctx.interaction.reply(
          resultReply(
            "Bot missing permission",
            "I need the **Manage Expressions** permission to add emojis.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const input = ctx.interaction.options.getString("emoji", true).trim();
      const match = CUSTOM_EMOJI_RE.exec(input);
      if (!match) {
        await ctx.interaction.reply(
          resultReply(
            "Invalid emoji",
            "Paste a custom emoji like `<:name:1234567890>` or `<a:name:1234567890>`. Unicode emoji cannot be stolen.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const animated = match[1] === "a";
      const sourceName = match[2];
      const id = match[3];
      const rename = ctx.interaction.options.getString("name");
      const name = sanitizeEmojiName(rename?.trim() || sourceName);
      if (!name) {
        await ctx.interaction.reply(
          resultReply(
            "Invalid name",
            "Emoji names must be 2-32 characters and only letters, numbers, or underscores.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      if (guild.emojis.cache.some((emoji) => emoji.name === name)) {
        await ctx.interaction.reply(
          resultReply(
            "Name taken",
            `This server already has an emoji named \`${name}\`. Pick a different name.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const ext = animated ? "gif" : "png";
      const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=128&quality=lossless`;

      try {
        const created = await guild.emojis.create({ attachment: url, name });
        await ctx.interaction.editReply(
          embedEdit(
            setEmbedAuthor(
              baseEmbed(),
              "Emoji stolen",
              ctx.client,
              commandHeader(ctx.guildConfig, { tone: "success" }),
            )
              .setDescription(`Added ${created} as \`:${created.name}:\``)
              .setThumbnail(created.imageURL({ size: 128 }))
              .addFields(
                embedField("Name", created.name ?? name, true),
                embedField("ID", created.id, true),
                embedField("Animated", created.animated ? "Yes" : "No", true),
              ),
          ),
        );
      } catch (err) {
        let message = "Could not add that emoji. Check emoji slots and that the source emoji still exists.";
        if (err instanceof DiscordAPIError) {
          if (err.code === 30008) message = "This server has no free emoji slots for that type.";
          else if (err.code === 50035) message = "Discord rejected the emoji name or image.";
          else if (err.code === 50045) message = "That emoji file is too large for Discord.";
          else if (err.message) message = err.message;
        }
        await ctx.interaction.editReply(
          resultEdit("Steal failed", message, slashResultOptions(ctx, { tone: "error" })),
        );
      }
    },
  },
];
