import { SlashCommandBuilder, type AutocompleteInteraction, type Client, type Guild, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, embedEdit, embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { discordTimestamp } from "../../core/datetime.js";
import { baseEmbed } from "../../core/embeds.js";
import { resolveEmojiForContent } from "../../core/emoji.js";
import { emitLog } from "../../core/logging/send.js";
import { getStocksUrl, siteLinkRow } from "../../core/docsUrl.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import { GLOBAL_DAILY_AMOUNT, formatCoinAmount, formatGlobal, formatServer, formatStockChange } from "./functions/format.js";
import {
  claimGlobalDaily,
  claimServerDaily,
  ensureGlobalAccount,
  ensureServerAccount,
  getGlobalBalance,
  getServerBalance,
  nextDailyClaimAt,
  type DailyClaimResult,
} from "./functions/money.js";
import {
  buyStock,
  ensureStock,
  getPortfolio,
  getStockBySymbol,
  getStockWithChange,
  listStocks,
  searchStocks,
  sellStock,
  StockError,
  type StockRow,
} from "./functions/stocks.js";

/** Resolves the "symbol" option to a listed stock, defaulting to the current guild's own listing (listing it now if needed). */
function resolveTradeStock(guild: Guild, symbolInput: string | null): StockRow | null {
  if (symbolInput) return getStockBySymbol(symbolInput);
  return ensureStock(guild.id, guild.name, guild.iconURL({ size: 64 }));
}

function changeArrow(changeAmount: number): string {
  return changeAmount > 0 ? "📈" : changeAmount < 0 ? "📉" : "➖";
}

function exchangeLinkRow() {
  return siteLinkRow({ label: "Dreamliner Exchange", url: getStocksUrl() });
}

/** Autocomplete for the "symbol" option shared by /stock view and /stock trade buy|sell. */
export async function handleStockAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "symbol") {
    await interaction.respond([]);
    return;
  }
  const matches = searchStocks(String(focused.value ?? ""), 25);
  await interaction.respond(matches.map((s) => ({ name: `${s.symbol} - ${s.guildName}`.slice(0, 100), value: s.symbol })));
}

/** Footer for a balance/daily embed — "Bank of {server}" with the server icon, or "Bank of Dreamliner" with the bot's avatar for the global currency. */
function bankFooter(which: "global" | "server", guild: Guild, client: Client): { text: string; iconURL?: string } {
  if (which === "global") {
    return { text: "Bank of Dreamliner", iconURL: client.user?.displayAvatarURL() };
  }
  return { text: `Bank of ${guild.name}`, iconURL: guild.iconURL() ?? undefined };
}

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
        .setFooter(bankFooter(which, i.guild!, ctx.client));

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
      let lastDailyAt: Date | null;

      if (which === "global") {
        claim = claimGlobalDaily(userId, GLOBAL_DAILY_AMOUNT);
        const account = ensureGlobalAccount(userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
      } else {
        if (config.server.daily_amount > 0) {
          claim = claimServerDaily(guildId, userId, config.server.daily_amount);
        } else {
          disabled = true;
        }
        const account = ensureServerAccount(guildId, userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
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
      const nextAt = claim ? claim.nextAt : nextDailyClaimAt(lastDailyAt);
      if (nextAt) description += `  ✧  Next claim ${discordTimestamp(nextAt)}`;

      const member = i.member as GuildMember | null;
      const bank = bankFooter(which, i.guild!, ctx.client);
      const embed = baseEmbed()
        .setAuthor({ name: member?.displayName ?? i.user.username, iconURL: i.user.displayAvatarURL() })
        .setDescription(description)
        .setFooter({ text: `${bank.text}  ✧  🔥 streak: ${streak}`, iconURL: bank.iconURL });

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
          .addStringOption((o) =>
            o
              .setName("emoji")
              .setDescription("Emoji shown next to amounts, e.g. 🪙 or <:coin:123>. Empty clears it.")
              .setMaxLength(64),
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
              `**Emoji:** ${s.currency_emoji.trim() || "none"}`,
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
      const emoji = i.options.getString("emoji") ?? config.server.currency_emoji;
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
            currency_emoji: emoji,
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
    data: new SlashCommandBuilder()
      .setName("stock")
      .setDescription("Invest your global coins in the Dreamliner Exchange")
      .addSubcommand((s) =>
        s
          .setName("view")
          .setDescription("View a stock's price and 24h change")
          .addStringOption((o) =>
            o.setName("symbol").setDescription("Ticker symbol (defaults to this server's stock)").setAutocomplete(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("top")
          .setDescription("Top stocks on the exchange by price")
          .addIntegerOption((o) =>
            o.setName("limit").setDescription("How many to show (default 10, max 25)").setMinValue(1).setMaxValue(25),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("portfolio")
          .setDescription("View a member's stock portfolio")
          .addUserOption((o) => o.setName("user").setDescription("Member to view")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("trade")
          .setDescription("Buy or sell stock")
          .addSubcommand((s) =>
            s
              .setName("buy")
              .setDescription("Buy shares with your global coins")
              .addNumberOption((o) => o.setName("amount").setDescription("Coins to spend").setRequired(true).setMinValue(0.01))
              .addStringOption((o) =>
                o.setName("symbol").setDescription("Ticker symbol (defaults to this server's stock)").setAutocomplete(true),
              ),
          )
          .addSubcommand((s) =>
            s
              .setName("sell")
              .setDescription("Sell shares back for global coins")
              .addNumberOption((o) => o.setName("shares").setDescription("Shares to sell").setRequired(true).setMinValue(0.0001))
              .addStringOption((o) =>
                o.setName("symbol").setDescription("Ticker symbol (defaults to this server's stock)").setAutocomplete(true),
              ),
          ),
      ),
    execute: async (ctx) => {
      const i = ctx.interaction;
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();

      // ── /stock view ──────────────────────────────────────────────────────
      if (!group && sub === "view") {
        const auth = await requirePluginPermission(ctx, "economy", "can_balance");
        if (!auth) return;
        const symbolInput = i.options.getString("symbol");
        const stock = resolveTradeStock(i.guild!, symbolInput);
        if (!stock) {
          await i.reply(
            resultReply("Not found", `No stock listed for symbol \`${symbolInput}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        const withChange = getStockWithChange(stock.guildId)!;
        const embed = baseEmbed()
          .setAuthor({ name: `${stock.symbol} - ${stock.guildName}`, iconURL: stock.guildIcon ?? undefined })
          .setThumbnail(stock.guildIcon)
          .addFields(
            { name: "Price", value: formatCoinAmount(withChange.price), inline: true },
            {
              name: "24h change",
              value: `${changeArrow(withChange.changeAmount)} ${formatStockChange(withChange.changeAmount, withChange.changePct)}`,
              inline: true,
            },
            { name: "Activity", value: `${withChange.activityScore}x exchange avg`, inline: true },
          )
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply({ ...embedReply(embed, ctx.ephemeral), components: [exchangeLinkRow()] });
        return;
      }

      // ── /stock top ───────────────────────────────────────────────────────
      if (!group && sub === "top") {
        const auth = await requirePluginPermission(ctx, "economy", "can_balance");
        if (!auth) return;
        const limit = i.options.getInteger("limit") ?? 10;
        const stocks = listStocks({ limit });
        const lines = stocks.map(
          (s, idx) =>
            `**${idx + 1}.** \`${s.symbol}\` ${s.guildName} - ${formatCoinAmount(s.price)}  ${changeArrow(s.changeAmount)} ${formatStockChange(s.changeAmount, s.changePct)}`,
        );
        const embed = baseEmbed()
          .setAuthor({ name: "Dreamliner Exchange - Top stocks", iconURL: ctx.client.user?.displayAvatarURL() })
          .setDescription(lines.join("\n") || "No stocks listed yet.")
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply({ ...embedReply(embed, ctx.ephemeral), components: [exchangeLinkRow()] });
        return;
      }

      // ── /stock portfolio ─────────────────────────────────────────────────
      if (!group && sub === "portfolio") {
        const auth = await requirePluginPermission(ctx, "economy", "can_balance");
        if (!auth) return;
        const target = i.options.getUser("user") ?? i.user;
        const portfolio = getPortfolio(target.id);
        const lines = portfolio.positions.map(
          (p) => `\`${p.stock.symbol}\` **${p.shares}** shares - ${formatCoinAmount(p.marketValue)}  ${changeArrow(p.pl)} ${formatStockChange(p.pl, p.plPct)}`,
        );
        const embed = baseEmbed()
          .setAuthor({ name: `${target.username}'s portfolio`, iconURL: target.displayAvatarURL() })
          .setDescription(lines.join("\n") || "No positions yet.")
          .addFields(
            { name: "Portfolio value", value: formatCoinAmount(portfolio.totalValue), inline: true },
            { name: "Cash balance", value: formatCoinAmount(portfolio.balance), inline: true },
          )
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply({ ...embedReply(embed, ctx.ephemeral), components: [exchangeLinkRow()] });
        return;
      }

      // ── /stock trade buy|sell ────────────────────────────────────────────
      if (group === "trade") {
        const auth = await requirePluginPermission(ctx, "economy", "can_stock_trade");
        if (!auth) return;
        const symbolInput = i.options.getString("symbol");
        const stock = resolveTradeStock(i.guild!, symbolInput);
        if (!stock) {
          await i.reply(
            resultReply("Not found", `No stock listed for symbol \`${symbolInput}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        try {
          if (sub === "buy") {
            const amount = i.options.getNumber("amount", true);
            const result = buyStock(i.user.id, stock.guildId, amount);
            await i.reply(
              resultReply(
                "Stock purchased",
                `Bought **${result.shares}** shares of **${stock.symbol}** at ${formatCoinAmount(result.price)}/share.\n**New balance:** ${formatCoinAmount(result.balance)}`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "success" }),
                [exchangeLinkRow()],
              ),
            );
            return;
          }

          // sub === "sell"
          const shares = i.options.getNumber("shares", true);
          const result = sellStock(i.user.id, stock.guildId, shares);
          await i.reply(
            resultReply(
              "Stock sold",
              `Sold **${result.shares}** shares of **${stock.symbol}** at ${formatCoinAmount(result.price)}/share for ${formatCoinAmount(result.proceeds)}.\n**New balance:** ${formatCoinAmount(result.balance)}`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success" }),
              [exchangeLinkRow()],
            ),
          );
        } catch (err) {
          if (err instanceof StockError) {
            const title = err.code === "insufficient" ? "Insufficient funds" : err.code === "not_found" ? "Not found" : "Trade failed";
            await i.reply(resultReply(title, err.message, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          throw err;
        }
      }
    },
  },
];
