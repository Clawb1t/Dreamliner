import { SlashCommandBuilder, type Client, type Guild, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, embedEdit, embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { discordTimestamp } from "../../core/datetime.js";
import { baseEmbed, memberAccentColor } from "../../core/embeds.js";
import { resolveEmojiForContent } from "../../core/emoji.js";
import type { Translator } from "../../i18n/index.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { globalEconomyFor } from "../../core/privacy/crossServer.js";
import { APP_EMOJI } from "../../core/appEmojis.js";
import {
  GLOBAL_DAILY_AMOUNT,
  SERVER_DAILY_AMOUNT,
  EXCHANGE_DAILY_GLOBAL_CAP,
  SERVER_TO_GLOBAL_EXCHANGE_RATE,
  formatExchangeRate,
  formatGlobal,
  formatServer,
} from "./functions/format.js";
import {
  claimGlobalDaily,
  claimServerDaily,
  ensureGlobalAccount,
  ensureServerAccount,
  exchangeServerForGlobal,
  getGlobalBalance,
  getServerBalance,
  ExchangeLimitError,
  InsufficientFundsError,
  nextDailyClaimAt,
  type DailyClaimResult,
} from "./functions/money.js";
import { hangarCommand, handlePlanesAutocomplete } from "./hangar/discord/commands.js";

/** Footer for a balance/daily embed — "Bank of {server}" with the server icon, or "Bank of Dreamliner" with the bot's avatar for the global currency. */
function bankFooter(which: "global" | "server", guild: Guild, client: Client, t: Translator): { text: string; iconURL?: string } {
  if (which === "global") {
    return { text: t("economy.bank.global", "Bank of Dreamliner"), iconURL: client.user?.displayAvatarURL() };
  }
  return { text: t("economy.bank.server", "Bank of {guild}", { guild: guild.name }), iconURL: guild.iconURL() ?? undefined };
}

export { handlePlanesAutocomplete };

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
      const targetMember = await i.guild!.members.fetch(target.id).catch(() => null);

      // A global balance moves with activity in every server: someone else's is the 00:00 UTC
      // figure, and hidden under Ghost Mode (core/privacy). Server balances are this server's own.
      let description: string;
      if (which === "global") {
        const view = target.id === i.user.id ? null : globalEconomyFor(i.user.id, target.id);
        if (target.id !== i.user.id && !view) {
          await i.reply(
            resultReply(
              ctx.t("economy.ghostTitle", "Ghost Mode is on"),
              ctx.t("economy.ghostBody", "<@{user}> has chosen to keep their activity across servers private, including their global balance.", { user: target.id }),
              true,
              slashResultOptions(ctx, { emoji: APP_EMOJI.locked }),
            ),
          );
          return;
        }
        description = formatGlobal(view ? view.balance : getGlobalBalance(target.id));
      } else {
        description = formatServer(getServerBalance(guildId, target.id), config.server);
      }

      const embed = baseEmbed()
        .setTitle(target.displayName)
        .setThumbnail(target.displayAvatarURL())
        .setColor(memberAccentColor(targetMember))
        .setDescription(description)
        .setFooter(bankFooter(which, i.guild!, ctx.client, ctx.t));

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

      const successEmoji = "<:icons_calenderdate:1544418081038663701>";
      const errorEmoji = resolveEmojiForContent(ctx.guildConfig.emojis.error, ctx.client);

      let claim: DailyClaimResult | null = null;
      let streak: number;
      let lastDailyAt: Date | null;

      if (which === "global") {
        claim = claimGlobalDaily(userId, GLOBAL_DAILY_AMOUNT);
        const account = ensureGlobalAccount(userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
      } else {
        claim = claimServerDaily(guildId, userId, SERVER_DAILY_AMOUNT);
        const account = ensureServerAccount(guildId, userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
      }

      let description: string;
      if (claim) {
        const amount = which === "global" ? formatGlobal(claim.amount) : formatServer(claim.amount, config.server);
        description = `${successEmoji} ${ctx.t("economy.daily.claimed", "+{amount}", { amount })}`;
      } else {
        description = `${errorEmoji} ${ctx.t("economy.daily.alreadyClaimed", "Already claimed")}`;
      }
      const nextAt = claim ? claim.nextAt : nextDailyClaimAt(lastDailyAt);
      if (nextAt)
        description += `  ✧  ${ctx.t("economy.daily.nextClaim", "Next claim {timestamp}", { timestamp: discordTimestamp(nextAt) })}`;

      const member = i.member as GuildMember | null;
      const bank = bankFooter(which, i.guild!, ctx.client, ctx.t);
      const embed = baseEmbed()
        .setTitle(member?.displayName ?? i.user.username)
        .setThumbnail(i.user.displayAvatarURL())
        .setColor(memberAccentColor(member))
        .setDescription(description)
        .setFooter({ text: `${bank.text}  ✧  <:icons_fire:1544417280375525437> streak: ${streak}`, iconURL: bank.iconURL });

      await i.editReply(embedEdit(embed));
    },
  },
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("exchange")
      .setDescription("Exchange this server's currency for global coins")
      .addNumberOption((o) =>
        o.setName("amount").setDescription("Amount of server currency to exchange").setRequired(true).setMinValue(0.01),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "economy", "can_exchange");
      if (!auth) return;
      const config = zEconomyConfig.parse(auth.pluginConfig);
      const i = ctx.interaction;
      const guild = i.guild!;
      const amount = i.options.getNumber("amount", true);
      const rate = SERVER_TO_GLOBAL_EXCHANGE_RATE;

      try {
        const result = exchangeServerForGlobal(guild.id, i.user.id, amount, rate);
        const member = i.member as GuildMember | null;
        const embed = baseEmbed()
          .setTitle(member?.displayName ?? i.user.username)
          .setThumbnail(i.user.displayAvatarURL())
          .setColor(memberAccentColor(member))
          .setDescription(
            `<:icons_swap:1544418225503084695> ${ctx.t(
              "economy.exchange.exchanged",
              "Exchanged {server} for {global}",
              { server: formatServer(result.serverAmount, config.server), global: formatGlobal(result.globalAmount) },
            )}`,
          )
          .addFields(
            { name: ctx.t("economy.exchange.rateField", "Exchange rate"), value: `\`${formatExchangeRate(rate)}\`` },
            {
              name: ctx.t("economy.exchange.newCurrencyBalance", "New {currency} balance", {
                currency: config.server.currency_name,
              }),
              value: formatServer(result.serverBalance, config.server),
            },
            { name: ctx.t("economy.exchange.newGlobalBalance", "New global balance"), value: formatGlobal(result.globalBalance) },
          )
          .setFooter({ text: ctx.t("economy.exchange.footer", "Dreamliner Exchange") });
        await i.reply(embedReply(embed, ctx.ephemeral));
      } catch (err) {
        if (err instanceof ExchangeLimitError) {
          await i.reply(
            resultReply(
              ctx.t("economy.exchange.limit.title", "Daily limit reached"),
              ctx.t(
                "economy.exchange.limit.description",
                "You can get up to {cap} from exchanges each day (across every server). You can still exchange up to {remaining} today.",
                { cap: formatGlobal(EXCHANGE_DAILY_GLOBAL_CAP), remaining: formatGlobal(err.remaining) },
              ),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
        if (err instanceof InsufficientFundsError) {
          await i.reply(
            resultReply(
              ctx.t("economy.exchange.insufficientFunds.title", "Insufficient funds"),
              ctx.t(
                "economy.exchange.insufficientFunds.description",
                "You don't have **{amount}** to exchange.",
                { amount: formatServer(amount, config.server) },
              ),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "error" }),
            ),
          );
          return;
        }
        throw err;
      }
    },
  },
  hangarCommand,
];
