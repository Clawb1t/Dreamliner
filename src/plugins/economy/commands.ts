import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, embedEdit, embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { discordTimestamp } from "../../core/datetime.js";
import { baseEmbed } from "../../core/embeds.js";
import { resolveEmojiForContent } from "../../core/emoji.js";
import { emitLog } from "../../core/logging/send.js";
import { getGuildStockUrl, getStocksUrl, siteLinkRow } from "../../core/docsUrl.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { GLOBAL_DAILY_AMOUNT, formatGlobal, formatServer } from "./functions/format.js";
import {
  claimGlobalDaily,
  claimServerDaily,
  ensureGlobalAccount,
  ensureServerAccount,
  getGlobalBalance,
  getServerBalance,
  type DailyClaimResult,
} from "./functions/money.js";

export const economyCommands: SlashCommandDefinition[] = [
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("balance")
      .setDescription("View a balance")
      .addStringOption((o) =>
        o
          .setName("currency")
          .setDescription("Which currency to view")
          .setRequired(true)
          .addChoices({ name: "Global", value: "global" }, { name: "Server", value: "server" }),
      )
      .addUserOption((o) => o.setName("user").setDescription("Member to view")),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "economy", "can_balance");
      if (!auth) return;
      const config = zEconomyConfig.parse(auth.pluginConfig);
      const i = ctx.interaction;
      const guildId = i.guildId!;
      const target = i.options.getUser("user") ?? i.user;
      const which = i.options.getString("currency", true) as "global" | "server";

      const description =
        which === "global" ? formatGlobal(getGlobalBalance(target.id)) : formatServer(getServerBalance(guildId, target.id), config.server);

      const embed = baseEmbed()
        .setAuthor({ name: target.displayName, iconURL: target.displayAvatarURL() })
        .setDescription(description)
        .setFooter({ text: which === "global" ? "Global currency" : "Server currency" });

      await i.reply(embedReply(embed, ctx.ephemeral));
    },
  },
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("daily")
      .setDescription("Claim a daily reward")
      .addStringOption((o) =>
        o
          .setName("currency")
          .setDescription("Which currency to claim")
          .setRequired(true)
          .addChoices({ name: "Global", value: "global" }, { name: "Server", value: "server" }),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "economy", "can_daily");
      if (!auth) return;
      const config = zEconomyConfig.parse(auth.pluginConfig);
      const i = ctx.interaction;
      const guildId = i.guildId!;
      const userId = i.user.id;
      const which = i.options.getString("currency", true) as "global" | "server";

      await i.deferReply(deferReplyOptions(ctx.ephemeral));

      const successEmoji = resolveEmojiForContent(ctx.guildConfig.emojis.success, ctx.client);
      const errorEmoji = resolveEmojiForContent(ctx.guildConfig.emojis.error, ctx.client);

      let claim: DailyClaimResult | null = null;
      let disabled = false;
      let streak: number;

      if (which === "global") {
        claim = claimGlobalDaily(userId, GLOBAL_DAILY_AMOUNT);
        streak = ensureGlobalAccount(userId).dailyStreak;
      } else {
        if (config.server.daily_amount > 0) {
          claim = claimServerDaily(guildId, userId, config.server.daily_amount);
        } else {
          disabled = true;
        }
        streak = ensureServerAccount(guildId, userId).dailyStreak;
      }

      let description: string;
      if (disabled) {
        description = `${errorEmoji} The server daily reward is disabled.`;
      } else if (claim) {
        const amount = which === "global" ? formatGlobal(claim.amount) : formatServer(claim.amount, config.server);
        description = `${successEmoji} +${amount}`;
      } else {
        description = `${errorEmoji} Already claimed`;
      }
      if (claim) description += `  ✧  Next claim ${discordTimestamp(claim.nextAt)}`;

      const member = i.member as GuildMember | null;
      const embed = baseEmbed()
        .setAuthor({ name: member?.displayName ?? i.user.username, iconURL: i.user.displayAvatarURL() })
        .setDescription(description)
        .setFooter({ text: `${which === "global" ? "Global currency" : "Server currency"}  ✧  🔥 streak: ${streak}` });

      await i.editReply(embedEdit(embed));
    },
  },
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("economy")
      .setDescription("Manager tools for this server's economy")
      .addSubcommand((s) => s.setName("view").setDescription("View this server's economy settings"))
      .addSubcommand((s) =>
        s
          .setName("settings")
          .setDescription("Update this server's economy settings")
          .addStringOption((o) => o.setName("name").setDescription("Currency name (plural), e.g. Credits").setMaxLength(32))
          .addStringOption((o) =>
            o.setName("name_singular").setDescription("Currency name (singular), e.g. Credit").setMaxLength(32),
          )
          .addStringOption((o) =>
            o.setName("denominator").setDescription("Prefix shown before amounts, e.g. $ in `$0.15`").setMaxLength(8),
          )
          .addNumberOption((o) =>
            o
              .setName("multiplier")
              .setDescription("Multiplier applied to all earnings (e.g. 1.5 = +50%)")
              .setMinValue(0)
              .setMaxValue(100),
          )
          .addNumberOption((o) =>
            o.setName("message_amount").setDescription("Currency earned per rewarded message").setMinValue(0),
          )
          .addIntegerOption((o) =>
            o
              .setName("message_cooldown_seconds")
              .setDescription("Cooldown between message rewards, in seconds")
              .setMinValue(0)
              .setMaxValue(86_400),
          )
          .addNumberOption((o) => o.setName("daily_amount").setDescription("Currency granted on /daily").setMinValue(0))
          .addBooleanOption((o) => o.setName("message_rewards_enabled").setDescription("Pay currency for sending messages")),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "economy", "can_admin_manage");
      if (!auth) return;
      const config = zEconomyConfig.parse(auth.pluginConfig);
      const i = ctx.interaction;
      const guildId = i.guildId!;
      const sub = i.options.getSubcommand();

      if (sub === "view") {
        const s = config.server;
        await i.reply(
          resultReply(
            "Server economy settings",
            [
              `**Currency:** ${s.currency_name} (\`${s.currency_name_singular}\` singular, \`${s.currency_denominator}\` denominator)`,
              `**Multiplier:** **${s.multiplier}x**`,
              `**Message rewards:** ${s.message_rewards_enabled ? "on" : "off"} — **${s.message_amount}** per message, **${s.message_cooldown_seconds}s** cooldown`,
              `**Daily reward:** **${s.daily_amount}**`,
            ].join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      // sub === "settings"
      const name = i.options.getString("name") ?? config.server.currency_name;
      const nameSingular = i.options.getString("name_singular") ?? config.server.currency_name_singular;
      const denominator = i.options.getString("denominator") ?? config.server.currency_denominator;
      const multiplier = i.options.getNumber("multiplier") ?? config.server.multiplier;
      const messageAmount = i.options.getNumber("message_amount") ?? config.server.message_amount;
      const messageCooldown =
        i.options.getInteger("message_cooldown_seconds") ?? config.server.message_cooldown_seconds;
      const dailyAmount = i.options.getNumber("daily_amount") ?? config.server.daily_amount;
      const messageRewardsEnabled =
        i.options.getBoolean("message_rewards_enabled") ?? config.server.message_rewards_enabled;

      const result = await ctx.configManager.patchPluginConfig(
        guildId,
        "economy",
        {
          server: {
            currency_name: name,
            currency_name_singular: nameSingular,
            currency_denominator: denominator,
            multiplier,
            message_amount: messageAmount,
            message_cooldown_seconds: messageCooldown,
            daily_amount: dailyAmount,
            message_rewards_enabled: messageRewardsEnabled,
          },
        },
        i.user.id,
      );
      if (!result.success) {
        await i.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
        return;
      }

      void emitLog(
        ctx.client,
        ctx.guildConfig,
        {
          title: "Economy settings updated",
          information: [`**By:** <@${i.user.id}>`, `**Currency:** ${name}`, `**Multiplier:** ${multiplier}x`],
          emojiCategory: "serverUpdate",
        },
        { guildId, eventType: "economy_admin_change", actorId: i.user.id, summary: "Economy settings updated" },
      ).catch(() => null);

      await i.reply(
        resultReply(
          "Economy settings updated",
          `**Currency:** ${name}\n**Multiplier:** ${multiplier}x\n**Message reward:** ${messageAmount} (${messageRewardsEnabled ? "on" : "off"})\n**Daily reward:** ${dailyAmount}`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
  {
    plugin: "economy",
    data: new SlashCommandBuilder().setName("stock").setDescription("Invest your global coins in the Dreamliner Exchange"),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "economy", "can_balance");
      if (!auth) return;
      const i = ctx.interaction;
      const guildId = i.guildId!;

      await i.reply(
        resultReply(
          "Dreamliner Exchange",
          "Every server with the economy enabled is listed on the exchange. Invest your global coins in a server's stock and watch it move with that server's activity, then buy, sell, and manage your portfolio on the site.",
          ctx.ephemeral,
          slashResultOptions(ctx),
          [siteLinkRow({ label: "Dreamliner Exchange", url: getStocksUrl() }, { label: "This server's stock", url: getGuildStockUrl(guildId) })],
        ),
      );
    },
  },
];
