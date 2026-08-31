import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type InteractionReplyOptions,
} from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { embedReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { baseEmbed } from "../../core/embeds.js";
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
import { formatCoinAmount, formatPlainAmount, planeLine } from "./functions/format.js";
import { PLANE_PACK_PREFIX } from "./functions/customIds.js";

const LIST_LIMIT = 25;

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
    const matches = searchPlaneTypes(query, LIST_LIMIT, { enabledOnly: true, ownedBy: owned });
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

export const planesCommands: SlashCommandDefinition[] = [
  {
    plugin: "planes",
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
        const auth = await requirePluginPermission(ctx, "planes", "can_view");
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
        const auth = await requirePluginPermission(ctx, "planes", "can_buy_pack");
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
        const auth = await requirePluginPermission(ctx, "planes", "can_view");
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
        const auth = await requirePluginPermission(ctx, "planes", "can_view");
        if (!auth) return;
        const rarityInput = i.options.getString("rarity");
        const rarity = rarityInput && isRarity(rarityInput) ? rarityInput : undefined;
        const typeInput = i.options.getString("type");
        const cardType = typeInput && isCardType(typeInput) ? typeInput : undefined;
        const cards = listPlaneTypes({ enabledOnly: true, rarity, cardType });
        const lines = cards.slice(0, LIST_LIMIT).map((p) => planeLine(p));
        if (cards.length > LIST_LIMIT) lines.push(`*+${cards.length - LIST_LIMIT} more...*`);

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
        const auth = await requirePluginPermission(ctx, "planes", "can_give");
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
