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
import { isDashboardSuperuser } from "../../bridge/superuser.js";
import {
  CARD_TYPE_META,
  CARD_TYPES,
  CatalogError,
  RARITY_META,
  RARITY_ORDER,
  createPlaneType,
  disablePlaneType,
  getPlaneTypeByKey,
  isCardType,
  isRarity,
  listPlaneTypes,
  normalizePlaneKey,
  searchPlaneTypes,
  updatePlaneType,
  type Rarity,
} from "./functions/catalog.js";
import { getSortedInventory, getOwnedPlaneTypeIds, giveCard, InventoryError } from "./functions/inventory.js";
import { isValidImageKey, listPlaneImageFiles, planeImageAttachment } from "./functions/images.js";
import { getPackSettings, setPackSettings } from "./functions/settings.js";
import { buildCardReveal, buildInventoryPage } from "./functions/cardDisplay.js";
import { cardTypeBadge, formatCoinAmount, formatPlainAmount, planeLine, rarityBadge } from "./functions/format.js";
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
    const isGive = interaction.commandName === "planes" && interaction.options.getSubcommandGroup(false) === "card" && interaction.options.getSubcommand(false) === "give";
    const enabledOnly = interaction.commandName !== "planesadmin";
    const owned = isGive ? getOwnedPlaneTypeIds(interaction.user.id) : undefined;
    const matches = searchPlaneTypes(query, LIST_LIMIT, { enabledOnly, ownedBy: owned });
    await interaction.respond(matches.map((p) => ({ name: `${p.name} (${p.key})`.slice(0, 100), value: p.key })));
    return;
  }

  if (focused.name === "image_key") {
    const q = query.trim().toLowerCase();
    const files = listPlaneImageFiles().filter((f) => !q || f.toLowerCase().includes(q));
    await interaction.respond(files.slice(0, LIST_LIMIT).map((f) => ({ name: f, value: f })));
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
  {
    // Split out from `/planes` entirely (not a subcommand group under it), and registered as a
    // guild command in one trusted guild only (see GUILD_ONLY_COMMAND_GUILDS in bot.ts) rather
    // than globally — Discord only supports hiding a whole command via defaultMemberPermissions,
    // not individual subcommand groups, and registering it nowhere else is a cleaner way to keep
    // it out of every other server than hiding-then-unhiding it there. Visible to everyone in
    // that one guild; the execute-time isDashboardSuperuser check below is what actually
    // enforces "only the bot's developers" for running it.
    plugin: "planes",
    data: new SlashCommandBuilder()
      .setName("planesadmin")
      .setDescription("Manage the card catalog (bot developers only)")
      .addSubcommand((s) =>
        s
          .setName("add_plane")
          .setDescription("Add a new plane card")
          .addStringOption((o) => o.setName("key").setDescription("Unique slug, e.g. boeing-747").setRequired(true).setMaxLength(48))
          .addStringOption((o) => o.setName("name").setDescription("Display name, e.g. Boeing 747").setRequired(true).setMaxLength(64))
          .addStringOption((o) => o.setName("rarity").setDescription("Rarity").setRequired(true).addChoices(...rarityChoices()))
          .addIntegerOption((o) => o.setName("speed").setDescription("Speed (0-100)").setRequired(true).setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("agility").setDescription("Agility (0-100)").setRequired(true).setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("safety").setDescription("Safety (0-100)").setRequired(true).setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("passengers").setDescription("Passenger count").setRequired(true).setMinValue(0).setMaxValue(1_000_000))
          .addStringOption((o) =>
            o.setName("image_key").setDescription("Image file name in assets/planes/, e.g. a350.png").setRequired(true).setMaxLength(128).setAutocomplete(true),
          )
          .addStringOption((o) => o.setName("manufacturer").setDescription("Manufacturer, e.g. Boeing").setMaxLength(64)),
      )
      .addSubcommand((s) =>
        s
          .setName("add_airline")
          .setDescription("Add a new airline card")
          .addStringOption((o) => o.setName("key").setDescription("Unique slug, e.g. delta-air-lines").setRequired(true).setMaxLength(48))
          .addStringOption((o) => o.setName("name").setDescription("Display name, e.g. Delta Air Lines").setRequired(true).setMaxLength(64))
          .addStringOption((o) => o.setName("rarity").setDescription("Rarity").setRequired(true).addChoices(...rarityChoices()))
          .addIntegerOption((o) => o.setName("reputation").setDescription("Reputation (0-100)").setRequired(true).setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("fleet_size").setDescription("Fleet size (aircraft count)").setRequired(true).setMinValue(0).setMaxValue(1_000_000))
          .addIntegerOption((o) => o.setName("destinations").setDescription("Number of destinations served").setRequired(true).setMinValue(0).setMaxValue(1_000_000))
          .addIntegerOption((o) => o.setName("safety").setDescription("Safety (0-100)").setRequired(true).setMinValue(0).setMaxValue(100))
          .addStringOption((o) =>
            o.setName("image_key").setDescription("Image file name in assets/planes/, e.g. delta.png").setRequired(true).setMaxLength(128).setAutocomplete(true),
          )
          .addStringOption((o) => o.setName("info").setDescription("Extra info, e.g. hub or founded year").setMaxLength(64)),
      )
      .addSubcommand((s) =>
        s
          .setName("edit")
          .setDescription("Edit an existing card")
          .addStringOption((o) => planeOption(o, "plane", "Card to edit"))
          .addStringOption((o) => o.setName("name").setDescription("Display name").setMaxLength(64))
          .addStringOption((o) => o.setName("rarity").setDescription("Rarity").addChoices(...rarityChoices()))
          .addStringOption((o) => o.setName("subtitle").setDescription("Manufacturer (planes) or extra info (airlines)").setMaxLength(64))
          .addIntegerOption((o) => o.setName("safety").setDescription("Safety (0-100), shared by both card types").setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("speed").setDescription("Speed (0-100), plane cards only").setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("agility").setDescription("Agility (0-100), plane cards only").setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("passengers").setDescription("Passenger count, plane cards only").setMinValue(0).setMaxValue(1_000_000))
          .addIntegerOption((o) => o.setName("reputation").setDescription("Reputation (0-100), airline cards only").setMinValue(0).setMaxValue(100))
          .addIntegerOption((o) => o.setName("fleet_size").setDescription("Fleet size, airline cards only").setMinValue(0).setMaxValue(1_000_000))
          .addIntegerOption((o) => o.setName("destinations").setDescription("Destinations served, airline cards only").setMinValue(0).setMaxValue(1_000_000))
          .addStringOption((o) =>
            o.setName("image_key").setDescription("Image file name in assets/planes/, e.g. a350.png").setMaxLength(128).setAutocomplete(true),
          )
          .addBooleanOption((o) => o.setName("enabled").setDescription("Whether this card appears in packs/catalog")),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Disable a card (keeps history intact)")
          .addStringOption((o) => planeOption(o, "plane", "Card to disable")),
      )
      .addSubcommand((s) =>
        s
          .setName("settings")
          .setDescription("View or change the global pack price/size (bot-wide, not per-server)")
          .addNumberOption((o) => o.setName("pack_price").setDescription("Global coin cost per pack").setMinValue(0).setMaxValue(1_000_000))
          .addIntegerOption((o) => o.setName("pack_size").setDescription("Cards revealed per pack (1-5)").setMinValue(1).setMaxValue(5)),
      ),
    execute: async (ctx) => {
      const i = ctx.interaction;
      const sub = i.options.getSubcommand();

      if (!isDashboardSuperuser(i.user.id)) {
        await i.reply(resultReply("Permission denied", "This command is limited to the bot's developers.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
        return;
      }

      if (sub === "add_plane" || sub === "add_airline") {
        const rarityInput = i.options.getString("rarity", true);
        if (!isRarity(rarityInput)) {
          await i.reply(resultReply("Invalid rarity", "Pick a rarity from the list.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const imageKey = i.options.getString("image_key", true);
        if (!isValidImageKey(imageKey)) {
          await i.reply(resultReply("Invalid image key", "Use a plain file name (png/jpg/jpeg/webp/gif), e.g. `a350.png`.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        if (!planeImageAttachment(imageKey)) {
          await i.reply(resultReply("Image not found", `No file named \`${imageKey}\` in \`assets/planes/\`. Drop it there first, then run this again.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        try {
          const plane =
            sub === "add_plane"
              ? createPlaneType({
                  key: i.options.getString("key", true),
                  name: i.options.getString("name", true),
                  cardType: "plane",
                  subtitle: i.options.getString("manufacturer") ?? "",
                  rarity: rarityInput,
                  speed: i.options.getInteger("speed", true),
                  agility: i.options.getInteger("agility", true),
                  passengerCount: i.options.getInteger("passengers", true),
                  safety: i.options.getInteger("safety", true),
                  imageKey,
                  createdBy: i.user.id,
                })
              : createPlaneType({
                  key: i.options.getString("key", true),
                  name: i.options.getString("name", true),
                  cardType: "airline",
                  subtitle: i.options.getString("info") ?? "",
                  rarity: rarityInput,
                  reputation: i.options.getInteger("reputation", true),
                  fleetSize: i.options.getInteger("fleet_size", true),
                  destinations: i.options.getInteger("destinations", true),
                  safety: i.options.getInteger("safety", true),
                  imageKey,
                  createdBy: i.user.id,
                });
          await i.reply(resultReply("Card added", `Added **${plane.name}** \`${plane.key}\` (${cardTypeBadge(plane.cardType)} · ${rarityBadge(plane.rarity)}).`, ctx.ephemeral, slashResultOptions(ctx)));
        } catch (err) {
          if (err instanceof CatalogError) {
            await i.reply(resultReply("Couldn't add card", err.message, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          throw err;
        }
        return;
      }

      if (sub === "edit") {
        const key = i.options.getString("plane", true);
        const plane = getPlaneTypeByKey(key);
        if (!plane) {
          await i.reply(resultReply("Not found", `No card found for \`${key}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const rarityInput = i.options.getString("rarity");
        if (rarityInput && !isRarity(rarityInput)) {
          await i.reply(resultReply("Invalid rarity", "Pick a rarity from the list.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        const imageKeyInput = i.options.getString("image_key");
        if (imageKeyInput !== null) {
          if (!isValidImageKey(imageKeyInput)) {
            await i.reply(resultReply("Invalid image key", "Use a plain file name (png/jpg/jpeg/webp/gif), e.g. `a350.png`.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
          if (!planeImageAttachment(imageKeyInput)) {
            await i.reply(resultReply("Image not found", `No file named \`${imageKeyInput}\` in \`assets/planes/\`. Drop it there first, then run this again.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
            return;
          }
        }

        const speed = i.options.getInteger("speed");
        const agility = i.options.getInteger("agility");
        const passengers = i.options.getInteger("passengers");
        const reputation = i.options.getInteger("reputation");
        const fleetSize = i.options.getInteger("fleet_size");
        const destinations = i.options.getInteger("destinations");

        if (plane.cardType === "airline" && (speed !== null || agility !== null || passengers !== null)) {
          await i.reply(resultReply("Wrong stats for this card", "`speed`/`agility`/`passengers` only apply to plane cards — this is an airline card.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        if (plane.cardType === "plane" && (reputation !== null || fleetSize !== null || destinations !== null)) {
          await i.reply(resultReply("Wrong stats for this card", "`reputation`/`fleet_size`/`destinations` only apply to airline cards — this is a plane card.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        const updated = updatePlaneType(plane.id, {
          name: i.options.getString("name") ?? undefined,
          subtitle: i.options.getString("subtitle") ?? undefined,
          rarity: rarityInput as Rarity | undefined,
          safety: i.options.getInteger("safety") ?? undefined,
          speed: speed ?? undefined,
          agility: agility ?? undefined,
          passengerCount: passengers ?? undefined,
          reputation: reputation ?? undefined,
          fleetSize: fleetSize ?? undefined,
          destinations: destinations ?? undefined,
          imageKey: imageKeyInput ?? undefined,
          enabled: i.options.getBoolean("enabled") ?? undefined,
        });
        await i.reply(resultReply("Card updated", `Updated **${updated.name}** \`${updated.key}\`.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "remove") {
        const key = i.options.getString("plane", true);
        const plane = getPlaneTypeByKey(key);
        if (!plane) {
          await i.reply(resultReply("Not found", `No card found for \`${key}\`.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }
        disablePlaneType(plane.id);
        await i.reply(resultReply("Card disabled", `**${plane.name}** \`${plane.key}\` no longer appears in packs or catalog listings. Existing cards are unaffected.`, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      // sub === "settings"
      const packPriceInput = i.options.getNumber("pack_price");
      const packSizeInput = i.options.getInteger("pack_size");
      if (packPriceInput === null && packSizeInput === null) {
        const current = getPackSettings();
        await i.reply(
          resultReply(
            "Pack settings",
            `**Price:** ${formatCoinAmount(current.packPrice)}\n**Size:** ${current.packSize} card${current.packSize === 1 ? "" : "s"} per pack`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }
      const updated = setPackSettings(
        { packPrice: packPriceInput ?? undefined, packSize: packSizeInput ?? undefined },
        i.user.id,
      );
      await i.reply(
        resultReply(
          "Pack settings updated",
          `**Price:** ${formatCoinAmount(updated.packPrice)}\n**Size:** ${updated.packSize} card${updated.packSize === 1 ? "" : "s"} per pack`,
          ctx.ephemeral,
          slashResultOptions(ctx),
        ),
      );
    },
  },
];

export { normalizePlaneKey };
