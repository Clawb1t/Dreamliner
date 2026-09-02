import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { hasPermission } from "../../core/permissionRoles.js";
import { resultEdit, resultReply, embedEdit, embedReply, slashResultOptions } from "../../core/responses.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../core/embeds.js";
import { scamProtectDefaultChannelName } from "./constants.js";
import {
  ensureScamProtectChannel,
  getScamProtectConfig,
  isScamProtectEnabled,
} from "./functions/ensure.js";

export const scamProtectCommands: SlashCommandDefinition[] = [
  {
    plugin: "scam_protect",
    data: new SlashCommandBuilder()
      .setName("scamprotect")
      .setDescription("Manage the Scam Protect honeypot channel")
      .addSubcommand((sub) =>
        sub.setName("setup").setDescription("Enable Scam Protect and create the honeypot channel"),
      )
      .addSubcommand((sub) =>
        sub.setName("status").setDescription("Show Scam Protect status"),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guild = ctx.interaction.guild!;
      const member = ctx.interaction.member;
      if (!member || typeof member === "string") {
        await ctx.interaction.reply(
          resultReply("Member error", "Could not resolve member.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (sub === "setup") {
        const allowed = await hasPermission(
          guild.id,
          "scam_protect",
          "can_setup",
          member as import("discord.js").GuildMember,
          ctx.guildConfig,
        );
        if (!allowed) {
          await ctx.interaction.reply(
            resultReply(
              "Permission denied",
              "You do not have permission to set up Scam Protect.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        const me = guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
          await ctx.interaction.reply(
            resultReply(
              "Bot missing permission",
              "I need **Manage Channels** to create the honeypot channel.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
        if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
          await ctx.interaction.reply(
            resultReply(
              "Bot missing permission",
              "I need **Ban Members** so Scam Protect can softban posters.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        await ctx.interaction.deferReply({ ephemeral: ctx.ephemeral });

        const enableResult = await ctx.configManager.setPluginEnabled(
          guild.id,
          "scam_protect",
          true,
          ctx.interaction.user.id,
        );
        if (!enableResult.success) {
          await ctx.interaction.editReply(
            resultEdit(
              "Setup failed",
              "Could not enable Scam Protect in the server config.",
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        const channel = await ensureScamProtectChannel(guild);
        if (!channel) {
          await ctx.interaction.editReply(
            resultEdit(
              "Setup failed",
              "Plugin enabled, but the honeypot channel could not be created. Check Manage Channels.",
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }

        await ctx.interaction.editReply(
          embedEdit(
            setEmbedAuthor(
              baseEmbed(),
              "Scam Protect ready",
              ctx.client,
              commandHeader(enableResult.data, {
                tone: "success",
                emoji: "<:icons_unusual_account:1544418255630901341>",
              }),
            )
              .setDescription(
                `Honeypot channel is ${channel}. Anyone who posts there (except ignored staff) will be softbanned.`,
              )
              .addFields(
                embedField("Channel name", `\`${channel.name}\``, true),
                embedField("Channel ID", channel.id, true),
              ),
          ),
        );
        return;
      }

      const allowed = await hasPermission(
        guild.id,
        "scam_protect",
        "can_status",
        member as import("discord.js").GuildMember,
        ctx.guildConfig,
      );
      if (!allowed) {
        await ctx.interaction.reply(
          resultReply(
            "Permission denied",
            "You do not have permission to view Scam Protect status.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const config = getScamProtectConfig(ctx.guildConfig);
      const expectedName = config.channel_name?.trim() || scamProtectDefaultChannelName();
      const channel = config.channel_id
        ? await guild.channels.fetch(config.channel_id).catch(() => null)
        : null;
      const ok =
        isScamProtectEnabled(ctx.guildConfig) && channel?.type === ChannelType.GuildText;

      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(
            baseEmbed(),
            "Scam Protect",
            ctx.client,
            commandHeader(ctx.guildConfig, { emoji: "<:icons_fingerprint:1544418020682899537>" }),
          )
            .setDescription(
              ok
                ? `Honeypot is active in ${channel}.`
                : isScamProtectEnabled(ctx.guildConfig)
                  ? "Enabled, but the honeypot channel is missing. Run `/scamprotect setup` or save config from the dashboard."
                  : "Disabled. Enable Scam Protect in the dashboard (or run `/scamprotect setup`).",
            )
            .addFields(
              embedField("Enabled", isScamProtectEnabled(ctx.guildConfig) ? "Yes" : "No", true),
              embedField("Channel", channel ? `${channel}` : "Not set", true),
              embedField("Ignored roles", config.ignored_roles.length ? `${config.ignored_roles.length}` : "None", true),
              embedField("Name", `\`${channel?.name ?? expectedName}\``, true),
            ),
          ctx.ephemeral,
        ),
      );
    },
  },
];
