import { MessageFlags, type ButtonInteraction } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { baseEmbed } from "../../../core/embeds.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { containerReply, resultEdit, resultReply, guildResultOptions } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { getPlaneTypeById } from "./catalog.js";
import { buildCardRevealBatch, buildInventoryPage } from "./cardDisplay.js";
import { PLANE_INVENTORY_PREFIX, PLANE_PACK_PREFIX, PLANE_SELL_PREFIX, PLANE_STATS_PREFIX } from "./customIds.js";
import { cardTypeBadge, rarityBadge, statsFields } from "./cardFormat.js";
import { formatCoinAmount } from "./format.js";
import { getInventoryEntry, getSortedInventory, sellCard, InventoryError } from "./inventory.js";
import { PackError, openPack } from "./packs.js";
import { getPackSettings } from "./settings.js";

export { PLANE_INVENTORY_PREFIX, PLANE_PACK_PREFIX, PLANE_SELL_PREFIX, PLANE_STATS_PREFIX };

export async function handlePlaneStatsButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLANE_STATS_PREFIX)) return false;
  const planeId = Number(interaction.customId.slice(PLANE_STATS_PREFIX.length));
  if (!Number.isInteger(planeId)) return false;

  const { t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply(t("economy.serverOnly.title", "Server only"), t("economy.serverOnly.description", "Use this in a server."), true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    await interaction.reply(
      resultReply(
        t("economy.pluginDisabled.title", "Plugin disabled"),
        t("economy.pluginDisabled.description", "The **economy** plugin is disabled for this server."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    if (!(await hasPermission(interaction.guildId, "economy", "can_view", member as import("discord.js").GuildMember, guildConfig))) {
      await interaction.reply(
        resultReply(
          t("economy.permissionDenied.title", "Permission denied"),
          t("economy.permissionDenied.view", "You do not have permission to view plane cards."),
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return true;
    }
  }

  const plane = getPlaneTypeById(planeId);
  if (!plane) {
    await interaction.reply(
      resultReply(
        t("economy.notFound.title", "Not found"),
        t("economy.notFound.planeGone", "That plane card no longer exists."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const owned = getInventoryEntry(interaction.user.id, plane.id);
  const ownedText = owned ? t("economy.stats.owned", "You own x{quantity}", { quantity: owned.quantity }) : null;
  const embed = baseEmbed()
    .setTitle(plane.name)
    .setThumbnail(interaction.client.user?.displayAvatarURL())
    .addFields(
      { name: t("economy.stat.type", "Type"), value: cardTypeBadge(plane.cardType, t), inline: true },
      { name: t("economy.stat.rarity", "Rarity"), value: rarityBadge(plane.rarity, t), inline: true },
      ...statsFields(plane, t),
    )
    .setFooter({ text: [plane.subtitle || null, ownedText].filter(Boolean).join(" · ") || t("economy.stats.hangarFooter", "Dreamliner Hangar") });

  await interaction.reply(containerReply(embed, true));
  return true;
}

function parsePackCustomId(customId: string): { action: "confirm" | "cancel"; userId: string } | null {
  const rest = customId.slice(PLANE_PACK_PREFIX.length);
  const match = /^(confirm|cancel):(\d{17,20})$/.exec(rest);
  if (!match) return null;
  return { action: match[1] as "confirm" | "cancel", userId: match[2] };
}

export async function handlePlanePackButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLANE_PACK_PREFIX)) return false;
  const parsed = parsePackCustomId(interaction.customId);
  if (!parsed) return false;

  const { t } = await translatorFor(interaction.user.id);

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({ content: t("economy.pack.notYours", "This isn't your pack purchase to confirm."), flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.update({ content: t("economy.serverOnly.description", "Use this in a server."), embeds: [], components: [] });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    await interaction.update({ content: t("economy.pluginDisabled.description", "The **economy** plugin is disabled for this server."), embeds: [], components: [] });
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    if (!(await hasPermission(interaction.guildId, "economy", "can_buy_pack", member as import("discord.js").GuildMember, guildConfig))) {
      await interaction.update({ content: t("economy.permissionDenied.buyPack", "You do not have permission to buy packs."), embeds: [], components: [] });
      return true;
    }
  }

  if (parsed.action === "cancel") {
    await interaction.update({ content: t("economy.pack.cancelled", "Purchase cancelled."), embeds: [], components: [] });
    return true;
  }

  try {
    const { packPrice, packSize } = getPackSettings();
    const result = openPack(interaction.user.id, interaction.guildId, packPrice, packSize, t);
    const { components, files } = buildCardRevealBatch(result.cards, interaction.user.id, t);
    const costText = result.cost > 0 ? formatCoinAmount(result.cost) : t("economy.pack.free", "free");
    const balanceText = formatCoinAmount(result.balance);
    const summary = baseEmbed().setDescription(
      t("economy.pack.summary", "<:icons_gift:1544417552627802212> Cost {cost} ✧ Balance {balance}", {
        cost: costText,
        balance: balanceText,
      }),
    );
    await interaction.update({
      flags: MessageFlags.IsComponentsV2,
      components: [...components, summary.toContainerComponent()],
      files,
    });
  } catch (err) {
    if (err instanceof PackError) {
      const title = err.code === "insufficient" ? t("economy.pack.insufficientTitle", "Not enough coins") : t("economy.pack.failedTitle", "Purchase failed");
      await interaction.update(
        resultEdit(title, err.message, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
      );
      return true;
    }
    throw err;
  }
  return true;
}

function parseInventoryCustomId(customId: string): { viewerId: string; targetUserId: string; index: number } | null {
  const rest = customId.slice(PLANE_INVENTORY_PREFIX.length);
  // The trailing "p:"/"n:" marker (see buildInventoryPage) only exists to keep the Back/Next
  // custom_ids distinct when they'd otherwise collide (a single-card hangar); it carries no
  // meaning here, only the destination index does.
  const match = /^(\d{17,20}):(\d{17,20}):[pn]:(\d+)$/.exec(rest);
  if (!match) return null;
  return { viewerId: match[1], targetUserId: match[2], index: Number(match[3]) };
}

export async function handlePlaneInventoryButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLANE_INVENTORY_PREFIX)) return false;
  const parsed = parseInventoryCustomId(interaction.customId);
  if (!parsed) return false;

  const { t } = await translatorFor(interaction.user.id);

  if (interaction.user.id !== parsed.viewerId) {
    await interaction.reply({ content: t("economy.inventory.notYours", "This isn't your hangar browser."), flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.update({ content: t("economy.serverOnly.description", "Use this in a server."), embeds: [], components: [] });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    await interaction.update({ content: t("economy.pluginDisabled.description", "The **economy** plugin is disabled for this server."), embeds: [], components: [] });
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    if (!(await hasPermission(interaction.guildId, "economy", "can_view", member as import("discord.js").GuildMember, guildConfig))) {
      await interaction.update({ content: t("economy.permissionDenied.view", "You do not have permission to view plane cards."), embeds: [], components: [] });
      return true;
    }
  }

  const cards = getSortedInventory(parsed.targetUserId);
  if (cards.length === 0) {
    await interaction.update({ content: t("economy.inventory.emptyNow", "That hangar is empty now."), embeds: [], components: [] });
    return true;
  }
  const index = Math.min(parsed.index, cards.length - 1);
  const { components, files } = buildInventoryPage(
    cards[index],
    {
      index,
      total: cards.length,
      viewerId: parsed.viewerId,
      targetUserId: parsed.targetUserId,
    },
    t,
  );
  await interaction.update({ flags: MessageFlags.IsComponentsV2, components, files });
  return true;
}

function parseSellCustomId(customId: string): { planeId: number; ownerId: string; price: number } | null {
  const rest = customId.slice(PLANE_SELL_PREFIX.length);
  const match = /^(\d+):(\d{17,20}):(\d+)$/.exec(rest);
  if (!match) return null;
  return { planeId: Number(match[1]), ownerId: match[2], price: Number(match[3]) / 100 };
}

/** Sells a card straight from its reveal/inventory-page "Sell for $X" button, at the exact price
 *  shown (rolled once when that button was built, see cardDisplay.ts) — replies ephemerally so
 *  the underlying pack reveal or hangar page it was clicked from is left untouched. */
export async function handlePlaneSellButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLANE_SELL_PREFIX)) return false;
  const parsed = parseSellCustomId(interaction.customId);
  if (!parsed) return false;

  const { t } = await translatorFor(interaction.user.id);

  if (interaction.user.id !== parsed.ownerId) {
    await interaction.reply({ content: t("economy.sell.notYours", "This isn't your card to sell."), flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply(t("economy.serverOnly.title", "Server only"), t("economy.serverOnly.description", "Use this in a server."), true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "economy")) {
    await interaction.reply(
      resultReply(
        t("economy.pluginDisabled.title", "Plugin disabled"),
        t("economy.pluginDisabled.description", "The **economy** plugin is disabled for this server."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    if (!(await hasPermission(interaction.guildId, "economy", "can_sell", member as import("discord.js").GuildMember, guildConfig))) {
      await interaction.reply(
        resultReply(
          t("economy.permissionDenied.title", "Permission denied"),
          t("economy.permissionDenied.sell", "You do not have permission to sell plane cards."),
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return true;
    }
  }

  const plane = getPlaneTypeById(parsed.planeId);
  if (!plane) {
    await interaction.reply(
      resultReply(
        t("economy.notFound.title", "Not found"),
        t("economy.notFound.planeGone", "That plane card no longer exists."),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  try {
    const balance = sellCard(interaction.user.id, parsed.planeId, parsed.price);
    await interaction.reply(
      resultReply(
        t("economy.sell.successTitle", "Card sold"),
        t(
          "economy.sell.success",
          "Sold **{plane}** for {price}.\n**New balance:** {balance}",
          { plane: plane.name, price: formatCoinAmount(parsed.price), balance: formatCoinAmount(balance) },
        ),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "success", emoji: "<:icons_bank:1544417487326679131>" }),
      ),
    );
  } catch (err) {
    if (err instanceof InventoryError) {
      await interaction.reply(
        resultReply(
          t("economy.sell.failTitle", "Couldn't sell card"),
          t("economy.sell.failDescription", "You no longer own **{plane}**.", { plane: plane.name }),
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return true;
    }
    throw err;
  }
  return true;
}
