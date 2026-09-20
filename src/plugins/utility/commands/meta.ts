import {
  ApplicationIntegrationType,
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resolveDocsUrl, siteLinkRow } from "../../../core/docsUrl.js";
import { buildVotePayload } from "../functions/vote.js";
import {
  resultReply,
  resultEdit,
  embedReply,
  embedEdit,
  slashResultOptions,
  deferReplyOptions,
} from "../../../core/responses.js";
import { baseEmbed, buildPingEmbed, commandHeader, embedField, memberAccentColor, setEmbedAuthor } from "../../../core/embeds.js";
import {
  ManageGuildExpressions,
  requireDiscordPerm,
  requireUtilityPermission,
} from "../functions/commandHelpers.js";
import { aboutLinkRows, buildAboutEmbed } from "../functions/about.js";
import { buildHelpMessage } from "../functions/help.js";
import {
  discordTimestamp,
  parseWhenInput,
  resolveTimezoneInput,
  TIMESTAMP_STYLES,
  timestampStyleLabel,
  type DiscordTimestampStyle,
} from "../functions/time.js";

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
    // No `permission` — voting should never need an admin to set up levels first,
    // so every member can use this the moment the utility plugin is enabled.
    plugin: "utility",
    data: new SlashCommandBuilder().setName("vote").setDescription("Vote for Dreamliner on top.gg"),
    execute: async (ctx) => {
      const payload = buildVotePayload(ctx.t);
      const flags: number = MessageFlags.IsComponentsV2 | (ctx.ephemeral ? MessageFlags.Ephemeral : 0);
      await ctx.interaction.reply({ ...payload, flags });
    },
  },
  {
    plugin: "utility",
    permission: "can_about",
    data: new SlashCommandBuilder().setName("about").setDescription("About Dreamliner"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_about");
      if (!auth) return;
      await ctx.interaction.reply(embedReply(buildAboutEmbed(ctx.client, ctx.t), ctx.ephemeral, aboutLinkRows(ctx.t)));
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
      await ctx.interaction.reply(buildHelpMessage(0, query, docsUrl, ctx.ephemeral, ctx.client, ctx.t, ctx.guildConfig.emojis));
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
        await ctx.interaction.reply(resultReply(ctx.t("utility.meta.reloadTitle", "Reload"), ctx.t("utility.meta.reloadNoCustomConfigBody", "No custom config stored; using defaults."), ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
        return;
      }
      await ctx.interaction.reply(
        resultReply(
          ctx.t("utility.meta.reloadTitle", "Reload"),
          ctx.t("utility.meta.reloadedBody", "Guild configuration reloaded."),
          ctx.ephemeral,
          slashResultOptions(ctx, { emoji: "<:icons_update:1544417598559752364>" }),
        ),
      );
    },
  },
  {
    plugin: "utility",
    permission: "can_avatar",
    // Also installable as a user app, so it works in DMs/group DMs and servers Dreamliner isn't
    // in — those contexts have no Dreamliner permission system, so `execute` below skips the
    // `can_avatar` gate whenever there's no guild.
    userInstallable: true,
    data: new SlashCommandBuilder()
      .setName("avatar")
      .setDescription("Show a user's avatar")
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
      .addUserOption((o) => o.setName("user").setDescription("User"))
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Global account avatar, or this server's avatar (default: global)")
          .addChoices({ name: "Global", value: "global" }, { name: "Server", value: "server" }),
      ),
    execute: async (ctx) => {
      if (ctx.interaction.inGuild()) {
        const auth = await requireUtilityPermission(ctx, "can_avatar");
        if (!auth) return;
      }
      const user = ctx.interaction.options.getUser("user") ?? ctx.interaction.user;
      const scope = ctx.interaction.options.getString("scope") ?? "global";

      // Force-fetch so `.banner` is populated — cached/interaction-supplied User objects
      // usually only carry the avatar hash, not the banner one.
      const fullUser = await ctx.client.users.fetch(user.id, { force: true }).catch(() => user);
      const member = ctx.interaction.guild ? await ctx.interaction.guild.members.fetch(user.id).catch(() => null) : null;

      let avatarUrl = fullUser.displayAvatarURL({ size: 2048, extension: "png" });
      if (scope === "server" && member) {
        avatarUrl = member.displayAvatarURL({ size: 2048, extension: "png" });
      }
      const bannerUrl = fullUser.bannerURL({ size: 2048, extension: "png" });

      const embed = setEmbedAuthor(
        baseEmbed(),
        ctx.t("utility.meta.avatarTitle", "Avatar"),
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: "<:icons_image:1544417559045079181>" }),
      )
        .setColor(memberAccentColor(member))
        .addFields(
          embedField(ctx.t("utility.meta.userLabel", "User"), `<@${user.id}>`),
          embedField(ctx.t("utility.meta.scopeLabel", "Scope"), scope === "server" ? ctx.t("utility.meta.scopeServer", "Server") : ctx.t("utility.meta.scopeGlobal", "Global")),
        );

      const downloadButtons = [{ label: ctx.t("utility.meta.downloadAvatarLabel", "Download avatar"), url: avatarUrl }];
      if (bannerUrl) {
        embed.setImages([avatarUrl, bannerUrl]);
        downloadButtons.push({ label: ctx.t("utility.meta.downloadBannerLabel", "Download banner"), url: bannerUrl });
      } else {
        embed.setImage(avatarUrl);
      }

      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral, [siteLinkRow(...downloadButtons)]));
    },
  },
  {
    plugin: "utility",
    permission: "can_time",
    data: new SlashCommandBuilder()
      .setName("time")
      .setDescription("Turn a time into a Discord timestamp that shows in everyone's own timezone")
      .addStringOption((o) =>
        o
          .setName("when")
          .setDescription("A moment, like 'now', '10 days ago', 'in 3 hours', '3pm', or 'next friday' (default: now)")
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("timezone")
          .setDescription("IANA name, GMT-style offset (GMT+5), or abbreviation (EST, JST) (default: UTC)")
          .setRequired(false),
      )
      .addStringOption((o) =>
        o
          .setName("style")
          .setDescription("Which timestamp style to lead with (default: a full date/time)")
          .setRequired(false)
          .addChoices(
            { name: "Short time (4:20 PM)", value: "t" },
            { name: "Long time (4:20:30 PM)", value: "T" },
            { name: "Short date (04/20/2026)", value: "d" },
            { name: "Long date (April 20, 2026)", value: "D" },
            { name: "Short date/time (April 20, 2026 4:20 PM)", value: "f" },
            { name: "Long date/time (Monday, April 20, 2026 4:20 PM)", value: "F" },
            { name: "Relative (in 2 days)", value: "R" },
          ),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_time");
      if (!auth) return;

      const timezoneRaw = ctx.interaction.options.getString("timezone");
      const tz = resolveTimezoneInput(timezoneRaw);
      if (!tz) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("utility.meta.timeTitle", "Time"),
            ctx.t(
              "utility.meta.timezoneNotRecognisedBody",
              "Couldn't recognise the timezone `{tz}`. Try an IANA name like `Europe/London`, a GMT-style offset like `GMT+5`, or an abbreviation like `EST`.",
              { tz: timezoneRaw ?? "" },
            ),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const whenRaw = ctx.interaction.options.getString("when");
      const parsed = parseWhenInput(whenRaw, tz);
      if (!parsed) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("utility.meta.timeTitle", "Time"),
            ctx.t(
              "utility.meta.whenNotUnderstoodBody",
              "Couldn't understand `{when}`. Try things like `now`, `10 days ago`, `in 3 hours`, `3pm`, or `next friday`.",
              { when: whenRaw ?? "" },
            ),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const leadStyle = (ctx.interaction.options.getString("style") as DiscordTimestampStyle | null) ?? "F";
      const lead = discordTimestamp(parsed.date, leadStyle);
      const resultLine = leadStyle === "R" ? lead : `${lead} · ${discordTimestamp(parsed.date, "R")}`;

      const formatsBlock = TIMESTAMP_STYLES.map((style) => {
        const code = discordTimestamp(parsed.date, style);
        return `\`${code}\` → ${code} (${timestampStyleLabel(ctx.t, style)})`;
      }).join("\n");

      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(baseEmbed(), ctx.t("utility.meta.timeTitle", "Time"), ctx.client, commandHeader(ctx.guildConfig, { emoji: "<:icons_clock:1544417185336664114>" }))
            .addFields(
              embedField(ctx.t("utility.meta.whenLabel", "When"), whenRaw?.trim() ? `\`${whenRaw.trim()}\`` : ctx.t("utility.meta.nowLabel", "now"), true),
              embedField(ctx.t("utility.meta.timezoneLabel", "Timezone"), tz.label, true),
              embedField(ctx.t("utility.meta.resultLabel", "Result"), resultLine),
              embedField(ctx.t("utility.meta.everyFormatLabel", "Every format (copy the code, keep the arrow)"), formatsBlock),
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
            setEmbedAuthor(baseEmbed(), ctx.t("utility.meta.emojiNameTitle", "Emoji: {name}", { name }), ctx.client, commandHeader(ctx.guildConfig))
              .setImage(url),
            ctx.ephemeral,
          ),
        );
        return;
      }
      await ctx.interaction.reply(resultReply(ctx.t("utility.meta.jumboTitle", "Jumbo"), ctx.t("utility.meta.jumboOnlyCustomBody", "Only custom server emojis can be jumbo'd."), ctx.ephemeral, slashResultOptions(ctx)));
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
          ctx.t,
        ))
      ) {
        return;
      }

      const guild = ctx.interaction.guild!;
      const me = guild.members.me;
      if (!me?.permissions.has(ManageGuildExpressions)) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("utility.meta.botMissingPermissionTitle", "Bot missing permission"),
            ctx.t("utility.meta.needManageExpressionsBody", "I need the **Manage Expressions** permission to add emojis."),
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
            ctx.t("utility.meta.invalidEmojiTitle", "Invalid emoji"),
            ctx.t("utility.meta.invalidEmojiBody", "Paste a custom emoji like `<:name:1234567890>` or `<a:name:1234567890>`. Unicode emoji cannot be stolen."),
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
            ctx.t("utility.meta.invalidNameTitle", "Invalid name"),
            ctx.t("utility.meta.invalidNameBody", "Emoji names must be 2-32 characters and only letters, numbers, or underscores."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      if (guild.emojis.cache.some((emoji) => emoji.name === name)) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("utility.meta.nameTakenTitle", "Name taken"),
            ctx.t("utility.meta.nameTakenBody", "This server already has an emoji named `{name}`. Pick a different name.", { name }),
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
              ctx.t("utility.meta.emojiStolenTitle", "Emoji stolen"),
              ctx.client,
              commandHeader(ctx.guildConfig, { tone: "success", emoji: "<:icons_upload2:1544418267412570193>" }),
            )
              .setDescription(ctx.t("utility.meta.emojiAddedAsBody", "Added {emoji} as `:{name}:`", { emoji: String(created), name: created.name }))
              .setThumbnail(created.imageURL({ size: 128 }))
              .addFields(
                embedField(ctx.t("utility.meta.nameLabel", "Name"), created.name ?? name, true),
                embedField(ctx.t("utility.meta.idLabel", "ID"), created.id, true),
                embedField(ctx.t("utility.meta.animatedLabel", "Animated"), created.animated ? ctx.t("utility.meta.yesLabel", "Yes") : ctx.t("utility.meta.noLabel", "No"), true),
              ),
          ),
        );
      } catch (err) {
        let message = ctx.t("utility.meta.couldNotAddEmojiBody", "Could not add that emoji. Check emoji slots and that the source emoji still exists.");
        if (err instanceof DiscordAPIError) {
          if (err.code === 30008) message = ctx.t("utility.meta.noFreeEmojiSlotsBody", "This server has no free emoji slots for that type.");
          else if (err.code === 50035) message = ctx.t("utility.meta.discordRejectedEmojiBody", "Discord rejected the emoji name or image.");
          else if (err.code === 50045) message = ctx.t("utility.meta.emojiFileTooLargeBody", "That emoji file is too large for Discord.");
          else if (err.message) message = err.message;
        }
        await ctx.interaction.editReply(
          resultEdit(ctx.t("utility.meta.stealFailedTitle", "Steal failed"), message, slashResultOptions(ctx, { tone: "error" })),
        );
      }
    },
  },
];
