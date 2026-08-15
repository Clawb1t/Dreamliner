import type { AutocompleteInteraction } from "discord.js";
import { zEconomyConfig } from "../../config/schemas/economy.js";
import * as inventory from "./functions/inventory.js";
import * as jobs from "./functions/jobs.js";
import * as pets from "./functions/pets.js";
import * as crafting from "./functions/crafting.js";
import * as quests from "./functions/quests.js";
import * as markets from "./functions/markets.js";
import { formatCurrency } from "./functions/format.js";

type Choice = { name: string; value: string };

function clip(text: string, max = 100): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function match(q: string, ...parts: Array<string | number | null | undefined>): boolean {
  if (!q) return true;
  return parts.some((part) => String(part ?? "")
    .toLowerCase()
    .includes(q));
}

export async function handleEconomyAutocomplete(interaction: AutocompleteInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const q = String(focused.value ?? "").toLowerCase();
  const userId = interaction.user.id;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  let choices: Choice[] = [];

  try {
    if (focused.name === "currency") {
      choices = [
        { name: "Coins", value: "coins" },
        { name: "Gems", value: "gems" },
      ].filter((c) => match(q, c.name, c.value));
    } else if (focused.name === "item") {
      choices = inventory
        .listItems(guildId)
        .filter((i) => match(q, i.key, i.name, i.emoji))
        .slice(0, 25)
        .map((i) => ({ name: clip(`${i.emoji} ${i.name}`), value: i.key }));
    } else if (focused.name === "shop") {
      choices = inventory
        .listShops(guildId)
        .filter((s) => s.enabled && match(q, s.key, s.name))
        .slice(0, 25)
        .map((s) => ({ name: clip(`🏪 ${s.name}`), value: s.key }));
    } else if (focused.name === "job") {
      choices = jobs
        .listJobs(guildId, true)
        .filter((j) => match(q, j.key, j.name, j.emoji))
        .slice(0, 25)
        .map((j) => ({ name: clip(`${j.emoji} ${j.name}`), value: j.key }));
    } else if (focused.name === "species") {
      choices = pets
        .listSpecies(guildId, true)
        .filter((s) => match(q, s.key, s.name, s.emoji))
        .slice(0, 25)
        .map((s) => ({ name: clip(`${s.emoji} ${s.name} (${s.rarity})`), value: s.key }));
    } else if (focused.name === "recipe") {
      choices = crafting
        .listRecipes(guildId, true)
        .filter((r) => match(q, r.key, r.name))
        .slice(0, 25)
        .map((r) => ({ name: clip(`🧰 ${r.name}`), value: r.key }));
    } else if (focused.name === "quest") {
      choices = quests
        .listQuests(guildId, true)
        .filter((r) => match(q, r.key, r.name))
        .slice(0, 25)
        .map((r) => ({ name: clip(`📜 ${r.name}`), value: r.key }));
    } else if (focused.name === "listing") {
      const config = zEconomyConfig.parse({});
      if (group === "shop") {
        const shops = inventory.listShops(guildId);
        choices = inventory
          .listShopListings(guildId)
          .filter((l) => l.enabled)
          .map((l) => {
            const item = inventory.getItemById(guildId, l.itemId);
            const shop = shops.find((s) => s.id === l.shopId);
            return {
              id: l.id,
              label: `${item?.emoji ?? "📦"} ${item?.name ?? "Item"} · ${formatCurrency(l.price, config, { currencyKey: l.currencyKey })} · ${shop?.name ?? "Shop"}`,
              search: [item?.name, item?.key, shop?.name, shop?.key, String(l.id)],
            };
          })
          .filter((row) => match(q, ...row.search))
          .slice(0, 25)
          .map((row) => ({ name: clip(row.label), value: String(row.id) }));
      } else {
        const mineOnly = sub === "cancel";
        choices = markets
          .listMarketListings(guildId)
          .filter((l) => (mineOnly ? l.sellerId === userId : true))
          .map((l) => {
            const item = inventory.getItemById(guildId, l.itemId);
            return {
              id: l.id,
              label: `${item?.emoji ?? "📦"} ${item?.name ?? "Item"} ×${l.quantity} · ${formatCurrency(l.price, config, { currencyKey: l.currencyKey })}`,
              search: [item?.name, item?.key, String(l.id)],
            };
          })
          .filter((row) => match(q, ...row.search))
          .slice(0, 25)
          .map((row) => ({ name: clip(row.label), value: String(row.id) }));
      }
    } else if (focused.name === "pet" || focused.name === "opponent") {
      const rows =
        focused.name === "pet" ? pets.listOwnedPets(guildId, userId) : pets.listGuildPets(guildId);
      choices = rows
        .filter((p) => match(q, p.name, String(p.id)))
        .slice(0, 25)
        .map((p) => {
          const species = pets.getSpeciesById(guildId, p.speciesId);
          const emoji = species?.emoji ?? "🐾";
          const ownerNote = focused.name === "opponent" && p.userId !== userId ? " · rival" : "";
          return {
            name: clip(`${emoji} ${p.name} · Lv${p.level}${ownerNote}`),
            value: String(p.id),
          };
        });
    } else if (focused.name === "id" && group === "craft") {
      choices = crafting
        .listQueue(guildId, userId, true)
        .filter((entry) => !entry.cancelled)
        .map((entry) => {
          const recipe = crafting.getRecipeById(guildId, entry.recipeId);
          const ready = entry.completesAt.getTime() <= Date.now();
          const status = entry.collected ? "collected" : ready ? "ready" : "crafting";
          return {
            id: entry.id,
            label: `${recipe?.name ?? "Craft"} · ${status}`,
            search: [recipe?.name, recipe?.key, status, String(entry.id)],
          };
        })
        .filter((row) => match(q, ...row.search))
        .slice(0, 25)
        .map((row) => ({ name: clip(row.label), value: String(row.id) }));
    } else if (focused.name === "trade") {
      choices = markets
        .listOpenTradesForUser(guildId, userId)
        .filter((t) => match(q, String(t.id), t.status))
        .slice(0, 25)
        .map((t) => ({
          name: clip(`Open trade · ${t.status}`),
          value: String(t.id),
        }));
    } else if (focused.name === "offer") {
      choices = markets
        .listOffersForUser(guildId, userId)
        .map(({ offer }) => {
          const item = offer.itemId ? inventory.getItemById(guildId, offer.itemId) : null;
          const label =
            offer.offerType === "currency"
              ? `Currency · ${offer.amount.toLocaleString()} ${offer.currencyKey ?? "coins"}`
              : `${item?.emoji ?? "📦"} ${item?.name ?? "Item"} ×${offer.quantity}`;
          return {
            id: offer.id,
            label,
            search: [label, item?.name, item?.key, String(offer.id)],
          };
        })
        .filter((row) => match(q, ...row.search))
        .slice(0, 25)
        .map((row) => ({ name: clip(row.label), value: String(row.id) }));
    } else if (focused.name === "auction") {
      const config = zEconomyConfig.parse({});
      const mineOnly = sub === "cancel";
      choices = markets
        .listAuctions(guildId)
        .filter((a) => (mineOnly ? a.sellerId === userId : true))
        .map((a) => {
          const item = inventory.getItemById(guildId, a.itemId);
          const bid = a.currentBid || a.startingBid;
          return {
            id: a.id,
            label: `${item?.emoji ?? "📦"} ${item?.name ?? "Item"} · ${formatCurrency(bid, config, { currencyKey: a.currencyKey })}`,
            search: [item?.name, item?.key, String(a.id)],
          };
        })
        .filter((row) => match(q, ...row.search))
        .slice(0, 25)
        .map((row) => ({ name: clip(row.label), value: String(row.id) }));
    }
  } catch {
    choices = [];
  }

  await interaction.respond(choices.slice(0, 25));
}
