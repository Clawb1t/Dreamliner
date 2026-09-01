import { MessageFlags, type ButtonInteraction } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { baseEmbed } from "../../../core/embeds.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { hasPluginPermission } from "../../../core/permissions.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resultEdit, resultReply, guildResultOptions } from "../../../core/responses.js";
import { getPlaneTypeById } from "./catalog.js";
import { buildCardRevealBatch, buildInventoryPage } from "./cardDisplay.js";
import { PLANE_INVENTORY_PREFIX, PLANE_PACK_PREFIX, PLANE_SELL_PREFIX, PLANE_STATS_PREFIX } from "./customIds.js";
import { cardTypeBadge, formatCoinAmount, rarityBadge, statsFields } from "./format.js";
import { getInventoryEntry, getSortedInventory, sellCard, InventoryError } from "./inventory.js";
import { PackError, openPack } from "./packs.js";
import { getPackSettings } from "./settings.js";

export { PLANE_INVENTORY_PREFIX, PLANE_PACK_PREFIX, PLANE_SELL_PREFIX, PLANE_STATS_PREFIX };

export async function handlePlaneStatsButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLANE_STATS_PREFIX)) return false;
  const planeId = Number(interaction.customId.slice(PLANE_STATS_PREFIX.length));
  if (!Number.isInteger(planeId)) return false;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "planes")) {
    await interaction.reply(
      resultReply("Plugin disabled", "The **planes** plugin is disabled for this server.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
    const defaults = getPluginDefaultOverrides("planes");
    if (!hasPluginPermission(guildConfig, "planes", "can_view", member as import("discord.js").GuildMember, interaction.channelId ?? "", categoryId, defaults)) {
      await interaction.reply(resultReply("Permission denied", "You do not have permission to view plane cards.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
  }

  const plane = getPlaneTypeById(planeId);
  if (!plane) {
    await interaction.reply(resultReply("Not found", "That plane card no longer exists.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return true;
  }

  const owned = getInventoryEntry(interaction.user.id, plane.id);
  const embed = baseEmbed()
    .setAuthor({ name: plane.name, iconURL: interaction.client.user?.displayAvatarURL() })
    .addFields(
      { name: "Type", value: cardTypeBadge(plane.cardType), inline: true },
      { name: "Rarity", value: rarityBadge(plane.rarity), inline: true },
      ...statsFields(plane),
    )
    .setFooter({ text: [plane.subtitle || null, owned ? `You own x${owned.quantity}` : null].filter(Boolean).join(" · ") || "Dreamliner Hangar" });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({ content: "This isn't your pack purchase to confirm.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.update({ content: "Use this in a server.", embeds: [], components: [] });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "planes")) {
    await interaction.update({ content: "The **planes** plugin is disabled for this server.", embeds: [], components: [] });
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
    const defaults = getPluginDefaultOverrides("planes");
    if (!hasPluginPermission(guildConfig, "planes", "can_buy_pack", member as import("discord.js").GuildMember, interaction.channelId ?? "", categoryId, defaults)) {
      await interaction.update({ content: "You do not have permission to buy packs.", embeds: [], components: [] });
      return true;
    }
  }

  if (parsed.action === "cancel") {
    await interaction.update({ content: "Purchase cancelled.", embeds: [], components: [] });
    return true;
  }

  try {
    const { packPrice, packSize } = getPackSettings();
    const result = openPack(interaction.user.id, interaction.guildId, packPrice, packSize);
    const { rows, files } = buildCardRevealBatch(result.cards, interaction.user.id);
    const embed = baseEmbed().setDescription(
      `Cost ${result.cost > 0 ? formatCoinAmount(result.cost) : "free"} ✧ Balance ${formatCoinAmount(result.balance)}`,
    );
    await interaction.update({
      content: "",
      embeds: [embed],
      components: rows,
      files,
    });
  } catch (err) {
    if (err instanceof PackError) {
      const title = err.code === "insufficient" ? "Not enough coins" : "Purchase failed";
      await interaction.update({
        content: "",
        ...resultEdit(title, err.message, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
        components: [],
      });
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

  if (interaction.user.id !== parsed.viewerId) {
    await interaction.reply({ content: "This isn't your hangar browser.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.update({ content: "Use this in a server.", embeds: [], components: [] });
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "planes")) {
    await interaction.update({ content: "The **planes** plugin is disabled for this server.", embeds: [], components: [] });
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
    const defaults = getPluginDefaultOverrides("planes");
    if (!hasPluginPermission(guildConfig, "planes", "can_view", member as import("discord.js").GuildMember, interaction.channelId ?? "", categoryId, defaults)) {
      await interaction.update({ content: "You do not have permission to view plane cards.", embeds: [], components: [] });
      return true;
    }
  }

  const cards = getSortedInventory(parsed.targetUserId);
  if (cards.length === 0) {
    await interaction.update({ content: "That hangar is empty now.", embeds: [], components: [] });
    return true;
  }
  const index = Math.min(parsed.index, cards.length - 1);
  const { embed, row, files } = buildInventoryPage(cards[index], {
    index,
    total: cards.length,
    viewerId: parsed.viewerId,
    targetUserId: parsed.targetUserId,
  });
  await interaction.update({ embeds: [embed], components: [row], files });
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

  if (interaction.user.id !== parsed.ownerId) {
    await interaction.reply({ content: "This isn't your card to sell.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "planes")) {
    await interaction.reply(
      resultReply("Plugin disabled", "The **planes** plugin is disabled for this server.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return true;
  }

  const member = interaction.member;
  if (member && typeof member !== "string") {
    const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
    const defaults = getPluginDefaultOverrides("planes");
    if (!hasPluginPermission(guildConfig, "planes", "can_sell", member as import("discord.js").GuildMember, interaction.channelId ?? "", categoryId, defaults)) {
      await interaction.reply(resultReply("Permission denied", "You do not have permission to sell plane cards.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
  }

  const plane = getPlaneTypeById(parsed.planeId);
  if (!plane) {
    await interaction.reply(resultReply("Not found", "That plane card no longer exists.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
    return true;
  }

  try {
    const balance = sellCard(interaction.user.id, parsed.planeId, parsed.price);
    await interaction.reply(
      resultReply(
        "Card sold",
        `Sold **${plane.name}** for ${formatCoinAmount(parsed.price)}.\n**New balance:** ${formatCoinAmount(balance)}`,
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "success" }),
      ),
    );
  } catch (err) {
    if (err instanceof InventoryError) {
      await interaction.reply(resultReply("Couldn't sell card", `You no longer own **${plane.name}**.`, true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return true;
    }
    throw err;
  }
  return true;
}
