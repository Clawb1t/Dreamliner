import type { AutocompleteInteraction } from "discord.js";
import * as inventory from "./functions/inventory.js";
import * as jobs from "./functions/jobs.js";
import * as pets from "./functions/pets.js";
import * as crafting from "./functions/crafting.js";
import * as quests from "./functions/quests.js";

export async function handleEconomyAutocomplete(interaction: AutocompleteInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  const q = String(focused.value ?? "").toLowerCase();
  let choices: { name: string; value: string }[] = [];

  if (focused.name === "currency") {
    choices = [
      { name: "coins", value: "coins" },
      { name: "gems", value: "gems" },
    ].filter((c) => !q || c.name.includes(q));
  } else if (focused.name === "item") {
    choices = inventory
      .listItems(guildId)
      .filter((i) => i.key.includes(q) || i.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((i) => ({ name: `${i.name} (${i.key})`.slice(0, 100), value: i.key }));
  } else if (focused.name === "shop") {
    choices = inventory
      .listShops(guildId)
      .filter((s) => s.key.includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((s) => ({ name: s.name.slice(0, 100), value: s.key }));
  } else if (focused.name === "job") {
    choices = jobs
      .listJobs(guildId, true)
      .filter((j) => j.key.includes(q) || j.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((j) => ({ name: j.name.slice(0, 100), value: j.key }));
  } else if (focused.name === "species") {
    choices = pets
      .listSpecies(guildId, true)
      .filter((s) => s.key.includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((s) => ({ name: s.name.slice(0, 100), value: s.key }));
  } else if (focused.name === "recipe") {
    choices = crafting
      .listRecipes(guildId, true)
      .filter((r) => r.key.includes(q) || r.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((r) => ({ name: r.name.slice(0, 100), value: r.key }));
  } else if (focused.name === "quest") {
    choices = quests
      .listQuests(guildId, true)
      .filter((r) => r.key.includes(q) || r.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((r) => ({ name: r.name.slice(0, 100), value: r.key }));
  }

  await interaction.respond(choices.slice(0, 25));
}
