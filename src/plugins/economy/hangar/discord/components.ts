import {
  ActionRowBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { configManager } from "../../../../config/manager.js";
import { baseEmbed } from "../../../../core/embeds.js";
import { hasPermission } from "../../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../../core/pluginCommand.js";
import { translatorFor, type Translator } from "../../../../i18n/index.js";
import { HANGAR_SLOT_STEP_PRICE } from "../constants.js";
import { expandHangar, getCopy, salvageCopies } from "../copies.js";
import { HangarError } from "../errors.js";
import { claimFlights } from "../flights.js";
import { getPartsBalance } from "../ledger.js";
import { buyListing, getListing } from "../market.js";
import { acceptTrade, cancelTrade, counterTrade, declineTrade, getTrade } from "../trades.js";
import { copyView, viewContext } from "../view.js";
import { packRevealMessage } from "./commands.js";
import { HE } from "./emojis.js";
import { buildHangarPage, buildTradeMessage } from "./pages.js";
import { HANGAR_PREFIX, LEGACY_PLANE_PREFIXES, button, coins, coinsLabel, copyLine, errorMessage, notice, parts, row, v2, type V2Message } from "./views.js";

const NO_PINGS = { parse: [] as never[] };
const TRADE_MODAL_PREFIX = `${HANGAR_PREFIX}trm:`;

export function isHangarComponent(customId: string): boolean {
  return customId.startsWith(HANGAR_PREFIX) || LEGACY_PLANE_PREFIXES.some((p) => customId.startsWith(p));
}

type Guard = { t: Translator } | null;

/** Plugin enabled + the member holds `flag` in this server. Replies (ephemeral) and returns null otherwise. */
async function guard(interaction: ButtonInteraction | ModalSubmitInteraction, flag: string): Promise<Guard> {
  const { t } = await translatorFor(interaction.user.id);
  const deny = async (title: string, body: string) => {
    const message = notice(title, body, "error", true);
    await interaction.reply({ components: message.components, flags: message.flags, allowedMentions: NO_PINGS });
    return null;
  };
  if (!interaction.inGuild() || !interaction.guildId) return deny(t("economy.serverOnly.title", "Server only"), t("economy.serverOnly.description", "Use this in a server."));
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    return deny(t("economy.pluginDisabled.title", "Plugin disabled"), t("economy.pluginDisabled.description", "The **economy** plugin is disabled for this server."));
  }
  const member = interaction.member;
  if (member && typeof member !== "string" && !(await hasPermission(interaction.guildId, "economy", flag, member as GuildMember, guildConfig))) {
    return deny(t("economy.permissionDenied.title", "Permission denied"), t("common.noPermission", "You do not have permission to use this command."));
  }
  return { t };
}

async function replyEphemeral(interaction: ButtonInteraction | ModalSubmitInteraction, message: V2Message): Promise<void> {
  const payload = { components: message.components, files: message.files, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: NO_PINGS };
  if (interaction.deferred && !interaction.replied) await interaction.editReply({ components: payload.components, files: payload.files, flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS });
  else if (interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function withErrors(interaction: ButtonInteraction | ModalSubmitInteraction, t: Translator, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = errorMessage(error, t, true);
    if (!message) throw error;
    await replyEphemeral(interaction, message);
  }
}

async function notYours(interaction: ButtonInteraction): Promise<boolean> {
  const { t } = await translatorFor(interaction.user.id);
  await replyEphemeral(interaction, notice(t("economy.hangar.notYoursTitle", "Not yours"), t("economy.hangar.notYours", "These buttons belong to someone else. Run the command yourself."), "error"));
  return true;
}

export async function handleHangarButton(interaction: ButtonInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (LEGACY_PLANE_PREFIXES.some((p) => id.startsWith(p))) {
    const { t } = await translatorFor(interaction.user.id);
    await replyEphemeral(
      interaction,
      notice(
        t("economy.hangar.legacyTitle", "The Hangar is here"),
        t("economy.hangar.legacy", "Plane cards moved to the Hangar. Selling for coins is gone; salvage cards for Parts instead. Try `/planes hangar`."),
        "info",
      ),
    );
    return true;
  }
  if (!id.startsWith(HANGAR_PREFIX)) return false;
  const [action, ...args] = id.slice(HANGAR_PREFIX.length).split(":");

  // Hangar paging: hv:<viewer>:<target>:<p|n>:<index>
  if (action === "hv") {
    const [viewerId, targetId, , index] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_view");
    if (!g) return true;
    await withErrors(interaction, g.t, async () => {
      const target = await interaction.client.users.fetch(targetId!).catch(() => null);
      const page = await buildHangarPage({ viewerId: viewerId!, targetId: targetId!, targetName: target?.displayName ?? "Pilot", index: Number(index) || 0, t: g.t });
      await interaction.update({ components: page.components, files: page.files, flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS });
    });
    return true;
  }

  // Salvage: sv (ask) and svc (confirm) :<viewer>:<copyId>
  if (action === "sv" || action === "svc") {
    const [viewerId, copyIdRaw] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_salvage");
    if (!g) return true;
    const copyId = Number(copyIdRaw);
    await withErrors(interaction, g.t, async () => {
      if (action === "sv") {
        const copy = getCopy(copyId);
        const view = copy ? copyView(copy, viewContext()) : null;
        if (!view) throw new HangarError("not_found", "That card copy doesn't exist.");
        const container = baseEmbed()
          .setTitle(`${HE.salvage} ${g.t("economy.hangar.salvage.confirmTitle", "Salvage this card?")}`)
          .setDescription(g.t("economy.hangar.salvage.confirm", "{card}\nYou get {parts}. This can't be undone.", { card: copyLine(view, g.t), parts: parts(view.salvageValue) }))
          .toContainerComponent([
            row(button(`${HANGAR_PREFIX}svc:${viewerId}:${copyId}`, g.t("economy.hangar.salvage.confirmButton", "Salvage"), ButtonStyle.Danger, HE.salvage)),
          ]);
        await replyEphemeral(interaction, v2([container]));
        return;
      }
      const result = salvageCopies(viewerId!, [copyId]);
      await interaction.update({
        components: notice(g.t("economy.hangar.salvage.title", "Salvaged"), g.t("economy.hangar.salvage.done", "+{parts}. You now have {balance}.", { parts: parts(result.parts), balance: parts(result.balance) }), "success").components,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
      });
    });
    return true;
  }

  // Hangar expansion: ex (ask) / exc (confirm) :<viewer>
  if (action === "ex" || action === "exc") {
    const [viewerId] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_view");
    if (!g) return true;
    await withErrors(interaction, g.t, async () => {
      if (action === "ex") {
        const container = baseEmbed()
          .setTitle(`${HE.hangar} ${g.t("economy.hangar.expand.confirmTitle", "Expand your hangar?")}`)
          .setDescription(g.t("economy.hangar.expand.confirm", "Buy more slots for {cost}. Coins spent here are gone for good.", { cost: coins(HANGAR_SLOT_STEP_PRICE) }))
          .toContainerComponent([row(button(`${HANGAR_PREFIX}exc:${viewerId}`, g.t("economy.hangar.expand.confirmButton", "Expand"), ButtonStyle.Primary, HE.hangar))]);
        await replyEphemeral(interaction, v2([container]));
        return;
      }
      const result = expandHangar(viewerId!);
      await interaction.update({
        components: notice(g.t("economy.hangar.expand.title", "Hangar expanded"), g.t("economy.hangar.expand.done", "You now have {slots} slots. Balance {balance}.", { slots: result.slots, balance: coins(result.balance) }), "success").components,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
      });
    });
    return true;
  }

  // Claim landed flights: fc:<viewer>
  if (action === "fc") {
    const [viewerId] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_fly");
    if (!g) return true;
    await withErrors(interaction, g.t, async () => {
      const result = claimFlights(viewerId!);
      await replyEphemeral(
        interaction,
        notice(
          g.t("economy.hangar.fly.claimedTitle", "Flights landed"),
          result.claimed.length
            ? g.t("economy.hangar.fly.claimedShort", "{count} flights claimed for {parts}. Balance {balance}.", { count: result.claimed.length, parts: parts(result.parts), balance: parts(getPartsBalance(viewerId!)) })
            : g.t("economy.hangar.fly.none", "None of your flights have landed. Check `/planes fly status`."),
          result.claimed.length ? "success" : "info",
        ),
      );
    });
    return true;
  }

  // Open a pack from the pack list: pko:<viewer>:<packKey>
  if (action === "pko") {
    const [viewerId, packKey] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_buy_pack");
    if (!g) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await withErrors(interaction, g.t, async () => {
      const message = await packRevealMessage(viewerId!, interaction.guildId!, packKey!, g.t);
      await interaction.editReply({ components: message.components, files: message.files, flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS });
    });
    return true;
  }

  // Market buy: mb (ask) / mbc (confirm) :<viewer>:<listingId>
  if (action === "mb" || action === "mbc") {
    const [viewerId, listingRaw] = args;
    if (interaction.user.id !== viewerId) return notYours(interaction);
    const g = await guard(interaction, "can_market");
    if (!g) return true;
    const listingId = Number(listingRaw);
    await withErrors(interaction, g.t, async () => {
      if (action === "mb") {
        const listing = getListing(listingId);
        const copy = listing ? getCopy(listing.copyId) : null;
        const view = copy ? copyView(copy, viewContext()) : null;
        if (!listing || !view || listing.status !== "active") throw new HangarError("conflict", "That listing is no longer for sale.");
        const container = baseEmbed()
          .setTitle(`${HE.market} ${g.t("economy.hangar.market.confirmTitle", "Buy this card?")}`)
          .setDescription(g.t("economy.hangar.market.confirm", "{card}\nPrice {price}.", { card: copyLine(view, g.t), price: coins(listing.price) }))
          .toContainerComponent([row(button(`${HANGAR_PREFIX}mbc:${viewerId}:${listingId}`, g.t("economy.hangar.market.buyButton", "Buy for {price}", { price: coinsLabel(listing.price) }), ButtonStyle.Success, HE.coin))]);
        await replyEphemeral(interaction, v2([container]));
        return;
      }
      const result = buyListing(viewerId!, listingId);
      await interaction.update({
        components: notice(g.t("economy.hangar.market.boughtTitle", "Bought"), g.t("economy.hangar.market.boughtShort", "Paid {price}. Balance {balance}. Find it in /planes hangar.", { price: coins(result.price), balance: coins(result.buyerBalance) }), "success").components,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
      });
    });
    return true;
  }

  // Trades: tra/trd/trc :<tradeId>, tro opens the counter modal.
  if (action === "tra" || action === "trd" || action === "trc" || action === "tro") {
    const tradeId = Number(args[0]);
    const g = await guard(interaction, "can_trade");
    if (!g) return true;
    await withErrors(interaction, g.t, async () => {
      const trade = getTrade(tradeId);
      if (!trade) throw new HangarError("not_found", "That trade doesn't exist.");
      if (action === "tro") {
        if (trade.toUserId !== interaction.user.id) throw new HangarError("forbidden", "Only the person the trade was sent to can counter it.");
        const modal = new ModalBuilder()
          .setCustomId(`${TRADE_MODAL_PREFIX}${trade.id}`)
          .setTitle(g.t("economy.hangar.trade.counterTitle", "Counter offer"))
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("give").setLabel(g.t("economy.hangar.trade.counterGive", "Card ids you give (comma separated)")).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("want").setLabel(g.t("economy.hangar.trade.counterWant", "Card ids you want (comma separated)")).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("coins").setLabel(g.t("economy.hangar.trade.counterCoins", "Coins you add")).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12),
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("ask").setLabel(g.t("economy.hangar.trade.counterAsk", "Coins you ask for")).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12),
            ),
          );
        await interaction.showModal(modal);
        return;
      }
      const updated =
        action === "tra"
          ? acceptTrade(trade.id, interaction.user.id)
          : action === "trd"
            ? declineTrade(trade.id, interaction.user.id)
            : cancelTrade(trade.id, interaction.user.id);
      const message = buildTradeMessage(updated, g.t);
      await interaction.update({ components: message.components, flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS });
    });
    return true;
  }

  return false;
}

function parseIds(raw: string): number[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => Number(s.replace(/^#/, "")))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export async function handleHangarModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(TRADE_MODAL_PREFIX)) return false;
  const tradeId = Number(interaction.customId.slice(TRADE_MODAL_PREFIX.length));
  const g = await guard(interaction, "can_trade");
  if (!g) return true;
  await withErrors(interaction, g.t, async () => {
    const field = (name: string) => interaction.fields.getTextInputValue(name) ?? "";
    const coinsRaw = Number(field("coins") || 0);
    const askRaw = Number(field("ask") || 0);
    if (!Number.isFinite(coinsRaw) || !Number.isFinite(askRaw)) throw new HangarError("invalid", "Coins must be numbers.");
    const trade = counterTrade(tradeId, interaction.user.id, {
      giveCopyIds: parseIds(field("give")),
      wantCopyIds: parseIds(field("want")),
      giveCoins: coinsRaw,
      wantCoins: askRaw,
    });
    const message = buildTradeMessage(trade, g.t);
    await interaction.reply({
      components: message.components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], users: [trade.toUserId] },
    });
  });
  return true;
}
