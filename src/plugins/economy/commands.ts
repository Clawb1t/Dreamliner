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
import { baseEmbed, memberAccentColor } from "../../core/embeds.js";
import { resolveEmojiForContent } from "../../core/emoji.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import {
  GLOBAL_DAILY_AMOUNT,
  formatCoinAmount,
  formatExchangeRate,
  formatGlobal,
  formatServer,
  formatStockChange,
  stockChangeArrow,
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
  listStocks,
  searchStocks,
  sellStock,
  StockError,
  type StockRow,
} from "./functions/stocks.js";
import { buildStockViewReply, exchangeLinkRow } from "./functions/stockView.js";
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
      const targetMember = await i.guild!.members.fetch(target.id).catch(() => null);

      const description =
        which === "global" ? formatGlobal(getGlobalBalance(target.id)) : formatServer(getServerBalance(guildId, target.id), config.server);

      const embed = baseEmbed()
        .setTitle(target.displayName)
        .setThumbnail(target.displayAvatarURL())
        .setColor(memberAccentColor(targetMember))
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
        .setTitle(member?.displayName ?? i.user.username)
        .setThumbnail(i.user.displayAvatarURL())
        .setColor(memberAccentColor(member))
        .setDescription(description)
        .setFooter({ text: `${bank.text}  ✧  🔥 streak: ${streak}`, iconURL: bank.iconURL });

      await i.editReply(embedEdit(embed));
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
          .setTitle(member?.displayName ?? i.user.username)
          .setThumbnail(i.user.displayAvatarURL())
          .setColor(memberAccentColor(member))
          .setDescription(
            `<:icons_swap:1544418225503084695> Exchanged ${formatServer(result.serverAmount, config.server)} for ${formatGlobal(result.globalAmount)}`,
          )
          .addFields(
            { name: "Exchange rate", value: `\`${formatExchangeRate(rate)}\` (${stock.symbol} @ ${formatCoinAmount(stock.price)})` },
            { name: `New ${config.server.currency_name} balance`, value: formatServer(result.serverBalance, config.server) },
            { name: "New global balance", value: formatGlobal(result.globalBalance) },
          )
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply(embedReply(embed, ctx.ephemeral, [exchangeLinkRow()]));
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
        await i.reply(await buildStockViewReply(stock, "24h", ctx.ephemeral));
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
            `**${idx + 1}.** \`${s.symbol}\` ${s.guildName} - ${formatCoinAmount(s.price)}  ${stockChangeArrow(s.changeAmount)} ${formatStockChange(s.changeAmount, s.changePct)}`,
        );
        const embed = baseEmbed()
          .setTitle("Dreamliner Exchange - Top stocks")
          .setThumbnail(ctx.client.user?.displayAvatarURL())
          .setDescription(lines.join("\n") || "No stocks listed yet.")
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply(embedReply(embed, ctx.ephemeral, [exchangeLinkRow()]));
        return;
      }

      // ── /stock portfolio ─────────────────────────────────────────────────
      if (!group && sub === "portfolio") {
        const auth = await requirePluginPermission(ctx, "economy", "can_balance");
        if (!auth) return;
        const target = i.options.getUser("user") ?? i.user;
        const targetMember = await i.guild!.members.fetch(target.id).catch(() => null);
        const portfolio = getPortfolio(target.id);
        const lines = portfolio.positions.map(
          (p) => `\`${p.stock.symbol}\` **${p.shares}** shares - ${formatCoinAmount(p.marketValue)}  ${stockChangeArrow(p.pl)} ${formatStockChange(p.pl, p.plPct)}`,
        );
        const embed = baseEmbed()
          .setTitle(`${target.username}'s portfolio`)
          .setThumbnail(target.displayAvatarURL())
          .setColor(memberAccentColor(targetMember))
          .setDescription(lines.join("\n") || "No positions yet.")
          .addFields(
            { name: "Portfolio value", value: formatCoinAmount(portfolio.totalValue) },
            { name: "Cash balance", value: formatCoinAmount(portfolio.balance) },
          )
          .setFooter({ text: "Dreamliner Exchange" });
        await i.reply(embedReply(embed, ctx.ephemeral, [exchangeLinkRow()]));
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
            const impactNote =
              result.marketPrice > result.price
                ? `\n${stockChangeArrow(1)} Your buy pushed the price up to ${formatCoinAmount(result.marketPrice)}.`
                : "";
            await i.reply(
              resultReply(
                "Stock purchased",
                `Bought **${result.shares}** shares of **${stock.symbol}** at ${formatCoinAmount(result.price)}/share.\n**New balance:** ${formatCoinAmount(result.balance)}${impactNote}`,
                ctx.ephemeral,
                slashResultOptions(ctx, { tone: "success", emoji: "<:icons_creditcard:1544417201686052905>" }),
                [exchangeLinkRow()],
              ),
            );
            return;
          }

          // sub === "sell"
          const shares = i.options.getNumber("shares", true);
          const result = sellStock(i.user.id, stock.guildId, shares);
          const impactNote =
            result.marketPrice < result.price
              ? `\n${stockChangeArrow(-1)} Your sell pushed the price down to ${formatCoinAmount(result.marketPrice)}.`
              : "";
          await i.reply(
            resultReply(
              "Stock sold",
              `Sold **${result.shares}** shares of **${stock.symbol}** at ${formatCoinAmount(result.price)}/share for ${formatCoinAmount(result.proceeds)}.\n**New balance:** ${formatCoinAmount(result.balance)}${impactNote}`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success", emoji: "<:icons_dollar:1544417229603348550>" }),
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

        const { components, files } = buildInventoryPage(cards[0], { index: 0, total: cards.length, viewerId: i.user.id, targetUserId: target.id });
        const reply: InteractionReplyOptions = {
          flags: MessageFlags.IsComponentsV2 | (ctx.ephemeral ? MessageFlags.Ephemeral : 0),
          components,
          ...(files.length ? { files } : {}),
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
        await i.reply(embedReply(embed, ctx.ephemeral, [row]));
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
        const { components, files } = buildCardReveal(plane);
        const reply: InteractionReplyOptions = {
          flags: MessageFlags.IsComponentsV2 | (ctx.ephemeral ? MessageFlags.Ephemeral : 0),
          components,
          ...(files.length ? { files } : {}),
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
          .setTitle(titleParts.length ? `${titleParts.join(" ")} cards` : "Card catalog")
          .setThumbnail(ctx.client.user?.displayAvatarURL())
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
          await i.reply(
            resultReply(
              "Card given",
              `Gave 1x **${plane.name}** to **${target.username}**.`,
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "success", emoji: "<:icons_gift:1544417552627802212>" }),
            ),
          );
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
