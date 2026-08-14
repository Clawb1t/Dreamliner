import type { Guild, GuildMember } from "discord.js";
import { renderTemplate } from "../../../core/templates.js";

const ANIMALS = [
  "Fox",
  "Wolf",
  "Bear",
  "Otter",
  "Hawk",
  "Lynx",
  "Panda",
  "Tiger",
  "Eagle",
  "Raven",
  "Deer",
  "Owl",
  "Seal",
  "Koala",
  "Whale",
];

const COLORS = [
  "Crimson",
  "Azure",
  "Amber",
  "Jade",
  "Violet",
  "Ivory",
  "Obsidian",
  "Coral",
  "Indigo",
  "Gold",
  "Teal",
  "Rose",
  "Silver",
  "Ember",
  "Sage",
];

const TREES = [
  "Oak",
  "Pine",
  "Maple",
  "Birch",
  "Cedar",
  "Willow",
  "Ash",
  "Elm",
  "Redwood",
  "Cherry",
  "Aspen",
  "Spruce",
  "Walnut",
  "Poplar",
  "Yew",
];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}

export function renderCompanionName(
  template: string,
  opts: {
    member?: GuildMember | null;
    guild: Guild;
    seq?: number;
    idle?: boolean;
  },
): string {
  const display = opts.idle ? "Open" : (opts.member?.displayName ?? opts.member?.user.username ?? "Room");
  const username = opts.idle ? "Open" : (opts.member?.user.username ?? "Room");
  const rendered = renderTemplate(template, {
    member: opts.member ?? undefined,
    guild: opts.guild,
    extra: {
      user: display,
      user_display: display,
      username,
      seq: opts.seq != null ? String(opts.seq) : "",
      animals: pick(ANIMALS),
      colors: pick(COLORS),
      trees: pick(TREES),
    },
  });
  const cleaned = rendered.replace(/\s+/g, " ").trim() || `${display}'s channel`;
  return cleaned.slice(0, 100);
}
