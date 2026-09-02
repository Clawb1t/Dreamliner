import {
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type GuildMember,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { baseEmbed } from "../../../core/embeds.js";
import { getStocksUrl, siteLinkRow } from "../../../core/docsUrl.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import { formatCoinAmount, formatStockChange, stockChangeArrow } from "./format.js";
import { renderStockChart } from "./stockChart.js";
import {
  buildStockCandles,
  classifyRSI,
  computeRSI,
  getStock,
  getStockHistory,
  getStockWithChange,
  type StockRange,
  type StockRow,
} from "./stocks.js";

// Shared by /stock view's initial reply and its time-period dropdown (a select menu that
// re-renders the same message in place, so switching range doesn't need a new command run) —
// same "one payload builder, reused by the reply and the component update" shape as the stats
// plugin's ui/index.ts + ui/buildPayload.ts.

export const STOCK_VIEW_RANGE_PREFIX = "dl:stockrange";

const RANGE_OPTIONS: { value: StockRange; label: string; candleTarget: number }[] = [
  { value: "24h", label: "Last 24 hours", candleTarget: 24 },
  { value: "7d", label: "Last 7 days", candleTarget: 28 },
  { value: "30d", label: "Last 30 days", candleTarget: 30 },
];

function candleTargetFor(range: StockRange): number {
  return RANGE_OPTIONS.find((r) => r.value === range)?.candleTarget ?? 24;
}

function rangeLabel(range: StockRange): string {
  return RANGE_OPTIONS.find((r) => r.value === range)?.label ?? range;
}

export function exchangeLinkRow() {
  return siteLinkRow({ label: "Dreamliner Exchange", url: getStocksUrl() });
}

export function buildStockRangeCustomId(guildId: string): string {
  return `${STOCK_VIEW_RANGE_PREFIX}:${guildId}`;
}

/** Time-period dropdown attached to /stock view — swaps the chart's range in place without re-running the command. */
export function buildStockRangeRow(guildId: string, selected: StockRange) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildStockRangeCustomId(guildId))
    .setPlaceholder(`Time period: ${rangeLabel(selected)}`)
    .addOptions(RANGE_OPTIONS.map((opt) => ({ label: opt.label, value: opt.value, default: opt.value === selected })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** "62.3 - Neutral" style readout for the RSI field, or a placeholder when there isn't a full 14-period reading yet. */
function rsiFieldValue(rsi: number | null): string {
  if (rsi == null) return "Not enough history yet";
  const reading = classifyRSI(rsi);
  const label = reading === "overbought" ? "Overbought" : reading === "oversold" ? "Oversold" : "Neutral";
  return `**${rsi.toFixed(1)}** - ${label}`;
}

/** Embed + candlestick chart + components for one stock at one time period — the RSI(14) figure is only reported as a stat field here, it isn't drawn into the chart image. */
async function buildStockViewContent(stock: StockRow, range: StockRange) {
  const withChange = getStockWithChange(stock.guildId)!;
  const history = getStockHistory(stock.guildId, range);
  const candles = buildStockCandles(history, candleTargetFor(range));
  const closes = candles.map((c) => c.close);
  const latestRSI = closes.length > 0 ? computeRSI(closes) : null;
  const chartFile = new AttachmentBuilder(await renderStockChart({ candles }), { name: "stock-chart.png" });

  const embed = baseEmbed()
    .setAuthor({ name: `${stock.symbol} - ${stock.guildName}`, iconURL: stock.guildIcon ?? undefined })
    .setThumbnail(stock.guildIcon)
    .setImage("attachment://stock-chart.png")
    .addFields(
      { name: "Price", value: formatCoinAmount(withChange.price), inline: true },
      {
        name: "24h change",
        value: `${stockChangeArrow(withChange.changeAmount)} ${formatStockChange(withChange.changeAmount, withChange.changePct)}`,
        inline: true,
      },
      { name: "Activity", value: `${withChange.activityScore}x exchange avg`, inline: true },
      { name: "RSI (14)", value: rsiFieldValue(latestRSI), inline: true },
    )
    .setFooter({ text: `Dreamliner Exchange · price chart, ${rangeLabel(range)}` });

  return {
    embeds: [embed],
    files: [chartFile],
    components: [buildStockRangeRow(stock.guildId, range), exchangeLinkRow()],
  };
}

export async function buildStockViewReply(stock: StockRow, range: StockRange, ephemeral: boolean): Promise<InteractionReplyOptions> {
  const content = await buildStockViewContent(stock, range);
  return { ...content, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) };
}

async function buildStockViewUpdate(stock: StockRow, range: StockRange): Promise<InteractionUpdateOptions> {
  return buildStockViewContent(stock, range);
}

function parseRange(value: string | undefined): StockRange {
  return value === "7d" || value === "30d" ? value : "24h";
}

/**
 * Handles /stock view's time-period dropdown. Self-contained (re-checks the economy plugin is
 * enabled and the member still has `can_balance`) the same way the plane-card button handlers in
 * cardButtons.ts are — this fires from the generic component dispatcher in bot.ts, not through a
 * SlashCommandContext, so there's no prior permission check to piggyback on.
 */
export async function handleStockRangeSelectInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(`${STOCK_VIEW_RANGE_PREFIX}:`)) return false;

  const stockGuildId = interaction.customId.slice(STOCK_VIEW_RANGE_PREFIX.length + 1);
  const range = parseRange(interaction.values[0]);

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        "The **economy** plugin is disabled for this server.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    if (!(await hasPermission(interaction.guildId, "economy", "can_balance", member as GuildMember, guildConfig))) {
      await interaction.reply(
        resultReply(
          "Permission denied",
          "You do not have permission to view stocks.",
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return true;
    }
  }

  const stock = getStock(stockGuildId);
  if (!stock) {
    await interaction.reply(
      resultReply("Not found", "That stock is no longer listed.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  await interaction.update(await buildStockViewUpdate(stock, range));
  return true;
}
