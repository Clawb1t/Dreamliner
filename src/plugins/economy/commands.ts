import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
} from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, embedEdit, embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { discordTimestamp } from "../../core/datetime.js";
import { baseEmbed } from "../../core/embeds.js";
import { resolveEmojiForContent } from "../../core/emoji.js";
import { emitLog } from "../../core/logging/send.js";
import { getStocksUrl, siteLinkRow } from "../../core/docsUrl.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import {
  GLOBAL_DAILY_AMOUNT,
  SERVER_MESSAGE_AMOUNT,
  SERVER_MESSAGE_COOLDOWN_SECONDS,
  formatCoinAmount,
  formatExchangeRate,
  formatGlobal,
  formatServer,
  formatStockChange,
} from "./functions/format.js";
import {
  claimGlobalDaily,
  claimServerDaily,
  ensureGlobalAccount,
  ensureServerAccount,
  exchangeServerForGlobal,
  getGlobalBalance,
  getServerBalance,
  InsufficientFundsError,
  nextDailyClaimAt,
  type DailyClaimResult,
} from "./functions/money.js";
import {
  buyStock,
  ensureStock,
  getExchangeRate,
  getPortfolio,
  getServerDailyAmount,
  getStockBySymbol,
  getStockWithChange,
  listStocks,
  searchStocks,
  sellStock,
  StockError,
  type StockRow,
} from "./functions/stocks.js";
import {
  CARD_TYPE_META,
  CARD_TYPES,
  RARITY_META,
  RARITY_ORDER,
  getPlaneTypeByKey,
  isCardType,
  isRarity,
  listPlaneTypes,
  searchPlaneTypes,
} from "./functions/catalog.js";
import { getSortedInventory, getOwnedPlaneTypeIds, giveCard, InventoryError } from "./functions/inventory.js";
import { getPackSettings } from "./functions/settings.js";
import { buildCardReveal, buildInventoryPage } from "./functions/cardDisplay.js";
import { formatPlainAmount, planeLine } from "./functions/cardFormat.js";
import { PLANE_PACK_PREFIX } from "./functions/customIds.js";

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

// ── Trading cards (planes/airlines) ──────────────────────────────────────────
// Collectible card catalog is global (bot-wide), not per-guild — see functions/settings.ts.

const CARD_LIST_LIMIT = 25;

function rarityChoices() {
  return RARITY_ORDER.map((r) => ({ name: RARITY_META[r].label, value: r }));
}

function cardTypeChoices() {
  return CARD_TYPES.map((t) => ({ name: CARD_TYPE_META[t].label, value: t }));
}

function planeOption(o: import("discord.js").SlashCommandStringOption, name: string, description: string, required = true) {
  return o.setName(name).setDescription(description).setRequired(required).setAutocomplete(true);
}

export async function handlePlanesAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "");

  if (focused.name === "plane") {
    const isGive = interaction.options.getSubcommandGroup(false) === "card" && interaction.options.getSubcommand(false) === "give";
    const owned = isGive ? getOwnedPlaneTypeIds(interaction.user.id) : undefined;
    const matches = searchPlaneTypes(query, CARD_LIST_LIMIT, { enabledOnly: true, ownedBy: owned });
    await interaction.respond(matches.map((p) => ({ name: `${p.name} (${p.key})`.slice(0, 100), value: p.key })));
    return;
  }

  await interaction.respond([]);
}

function requirePlane(key: string, opts: { enabledOnly?: boolean } = {}) {
  const plane = getPlaneTypeByKey(key);
  if (!plane || (opts.enabledOnly && !plane.enabled)) return null;
  return plane;
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
      let streak: number;
      let lastDailyAt: Date | null;

      if (which === "global") {
        claim = claimGlobalDaily(userId, GLOBAL_DAILY_AMOUNT);
        const account = ensureGlobalAccount(userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
      } else {
        // Scales with this server's own stock price — see stocks.ts's getServerDailyAmount.
        claim = claimServerDaily(guildId, userId, getServerDailyAmount(guildId));
        const account = ensureServerAccount(guildId, userId);
        streak = account.dailyStreak;
        lastDailyAt = account.lastDailyAt;
      }

      let description: string;
      if (claim) {
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
        const dailyAmount = getServerDailyAmount(guildId);
        const rate = getExchangeRate(guildId);
        await i.reply(
          resultReply(
            "Server economy settings",
            [
              `**Currency:** ${s.currency_name} (\`${s.currency_name_singular}\` singular, \`${s.currency_denominator}\` denominator)`,
              `**Emoji:** ${s.currency_emoji.trim() || "none"}`,
              `**Message rewards:** ${s.message_rewards_enabled ? "on" : "off"} — fixed **${SERVER_MESSAGE_AMOUNT}** per message, **${SERVER_MESSAGE_COOLDOWN_SECONDS}s** cooldown`,
              `**Daily reward:** ${formatServer(dailyAmount, s)} (market rate \`${formatExchangeRate(rate)}\`, tracks this server's Dreamliner Exchange stock)`,
            ].join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      // sub === "settings" — name, denominator, emoji, and the message-rewards on/off toggle are
      // still admin-configurable. Rates (message amount, cooldown, multiplier, daily amount)
      // aren't: they're fixed bot-wide, with the daily reward instead scaling automatically with
      // this server's own stock price — see the schema comment in config/schemas/economy.ts.
      const name = i.options.getString("name") ?? config.server.currency_name;
      const nameSingular = i.options.getString("name_singular") ?? config.server.currency_name_singular;
      const denominator = i.options.getString("denominator") ?? config.server.currency_denominator;
      const emoji = i.options.getString("emoji") ?? config.server.currency_emoji;
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
          information: [`**By:** <@${i.user.id}>`, `**Currency:** ${name}`, `**Message rewards:** ${messageRewardsEnabled ? "on" : "off"}`],
          emojiCategory: "serverUpdate",
        },
        { guildId, eventType: "economy_admin_change", actorId: i.user.id, summary: "Economy settings updated" },
      ).catch(() => null);

      await i.reply(
        resultReply(
          "Economy settings updated",
          `**Currency:** ${name}\n**Message rewards:** ${messageRewardsEnabled ? "on" : "off"}`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("exchange")
      .setDescription("Exchange this server's currency for global coins, at a rate set by the server's stock price")
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

      const stock = ensureStock(guild.id, guild.name, guild.iconURL({ size: 64 }));
      const rate = getExchangeRate(guild.id);

      try {
        const result = exchangeServerForGlobal(guild.id, i.user.id, amount, rate);
        const member = i.member as GuildMember | null;
        const embed = baseEmbed()
          .setAuthor({ name: member?.displayName ?? i.user.username, iconURL: i.user.displayAvatarURL() })
          .setDescription(
            `Exchanged ${formatServer(result.serverAmount, config.server)} for ${formatGlobal(result.globalAmount)}`,
          )
          .addFields(
            { name: "Exchange rate", value: `\`${formatExchangeRate(rate)}\` (${stock.symbol} @ ${formatCoinAmount(stock.price)})`, inline: false },
            { name: `New ${config.server.currency_name} balance`, value: formatServer(result.serverBalance, config.server), inline: true },
            { name: "New global balance", value: formatGlobal(result.globalBalance), inline: true },
          )
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply({ ...embedReply(embed, ctx.ephemeral), components: [exchangeLinkRow()] });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          await i.reply(
            resultReply(
              "Insufficient funds",
              `You don't have **${formatServer(amount, config.server)}** to exchange.`,
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
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("planes")
      .setDescription("Collect, open packs, and give Dreamliner trading cards (planes and airlines)")
      .addSubcommand((s) =>
        s
          .setName("inventory")
          .setDescription("View a hangar (card collection)")
          .addUserOption((o) => o.setName("user").setDescription("Member to view")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("pack")
          .setDescription("Buy card packs")
          .addSubcommand((s) => s.setName("buy").setDescription("Buy and open a pack with global coins")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("card")
          .setDescription("Browse the card catalog")
          .addSubcommand((s) =>
            s
              .setName("view")
              .setDescription("View a card's stats")
              .addStringOption((o) => planeOption(o, "plane", "Card")),
          )
          .addSubcommand((s) =>
            s
              .setName("list")
              .setDescription("List cards in the catalog")
              .addStringOption((o) => o.setName("rarity").setDescription("Filter by rarity").addChoices(...rarityChoices()))
              .addStringOption((o) => o.setName("type").setDescription("Filter by card type").addChoices(...cardTypeChoices())),
          )
          .addSubcommand((s) =>
            s
              .setName("give")
              .setDescription("Give one of your cards to another member")
              .addUserOption((o) => o.setName("user").setDescription("Member to give it to").setRequired(true))
              .addStringOption((o) => planeOption(o, "plane", "Card to give (1 at a time)")),
          ),
      ),
    execute: async (ctx) => {
      const i = ctx.interaction;
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();

      // ── /planes inventory ─────────────────────────────────────────────────
      if (!group && sub === "inventory") {
        const auth = await requirePluginPermission(ctx, "economy", "can_view");
        if (!auth) return;
        const target = i.options.getUser("user") ?? i.user;
        const cards = getSortedInventory(target.id);
        if (cards.length === 0) {
          await i.reply(
            resultReply(
              `${target.username}'s hangar`,
              "No cards yet. Buy a pack with `/planes pack buy`.",
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }

        const { embed, row, files } = buildInventoryPage(cards[0], { index: 0, total: cards.length, viewerId: i.user.id, targetUserId: target.id });
        const reply: InteractionReplyOptions = {
          embeds: [embed],
          components: [row],
          ...(files.length ? { files } : {}),
          ...(ctx.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        };
        await i.reply(reply);
        return;
      }

      // ── /planes pack buy ─────────────────────────────────────────────────
      if (group === "pack" && sub === "buy") {
        const auth = await requirePluginPermission(ctx, "economy", "can_buy_pack");
        if (!auth) return;
        const { packPrice } = getPackSettings();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${PLANE_PACK_PREFIX}confirm:${i.user.id}`)
            .setLabel(packPrice > 0 ? `Buy for ${formatPlainAmount(packPrice)}` : "Open pack (free)")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${PLANE_PACK_PREFIX}cancel:${i.user.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        );
        const embed = baseEmbed().setDescription(`Buy a card pack for ${packPrice > 0 ? formatCoinAmount(packPrice) : "free"}?`);
        const reply: InteractionReplyOptions = {
          embeds: [embed],
          components: [row],
          ...(ctx.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        };
        await i.reply(reply);
        return;
      }

      // ── /planes card view ────────────────────────────────────────────────
      if (group === "card" && sub === "view") {
        const auth = await requirePluginPermission(ctx, "economy", "can_view");
        if (!auth) return;
        const key = i.options.getString("plane", true);
        const plane = requirePlane(key, { enabledOnly: true });
        if (!plane) {
          await i.reply(resultReply("Not found", `No card found for \`${key}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const { row, files } = buildCardReveal(plane);
        const reply: InteractionReplyOptions = {
          components: [row],
          ...(files.length ? { files } : {}),
          ...(ctx.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        };
        await i.reply(reply);
        return;
      }

      // ── /planes card list ────────────────────────────────────────────────
      if (group === "card" && sub === "list") {
        const auth = await requirePluginPermission(ctx, "economy", "can_view");
        if (!auth) return;
        const rarityInput = i.options.getString("rarity");
        const rarity = rarityInput && isRarity(rarityInput) ? rarityInput : undefined;
        const typeInput = i.options.getString("type");
        const cardType = typeInput && isCardType(typeInput) ? typeInput : undefined;
        const cards = listPlaneTypes({ enabledOnly: true, rarity, cardType });
        const lines = cards.slice(0, CARD_LIST_LIMIT).map((p) => planeLine(p));
        if (cards.length > CARD_LIST_LIMIT) lines.push(`*+${cards.length - CARD_LIST_LIMIT} more...*`);

        const titleParts = [rarity ? RARITY_META[rarity].label : null, cardType ? CARD_TYPE_META[cardType].label : null].filter(Boolean);
        const embed = baseEmbed()
          .setAuthor({ name: titleParts.length ? `${titleParts.join(" ")} cards` : "Card catalog", iconURL: ctx.client.user?.displayAvatarURL() })
          .setDescription(lines.join("\n") || "No cards are available yet.")
          .setFooter({ text: `${cards.length} card${cards.length === 1 ? "" : "s"} · use /planes card view <plane> for details` });
        await i.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      // ── /planes card give ─────────────────────────────────────────────────
      if (group === "card" && sub === "give") {
        const auth = await requirePluginPermission(ctx, "economy", "can_give");
        if (!auth) return;
        const target = i.options.getUser("user", true);
        if (target.bot) {
          await i.reply(resultReply("Invalid gift", "You can't give a card to a bot.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        if (target.id === i.user.id) {
          await i.reply(resultReply("Invalid gift", "You can't give a card to yourself.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const key = i.options.getString("plane", true);
        const plane = requirePlane(key, { enabledOnly: true });
        if (!plane) {
          await i.reply(resultReply("Not found", `No card found for \`${key}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        try {
          giveCard(i.user.id, target.id, plane.id, 1);
          await i.reply(resultReply("Card given", `Gave 1x **${plane.name}** to **${target.username}**.`, ctx.ephemeral, slashResultOptions(ctx)));
        } catch (err) {
          if (err instanceof InventoryError) {
            await i.reply(resultReply("Couldn't give card", `You don't own **${plane.name}**.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          throw err;
        }
        return;
      }
    },
  },
];
