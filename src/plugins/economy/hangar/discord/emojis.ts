/** Dreamliner app emojis used by the Hangar (see app-emojis.txt). Never default unicode emoji. */
export const HE = {
  coin: "<:icons_coin:1544417186951598130>",
  parts: "<:icons_settings:1544417411875479642>",
  pack: "<:icons_gift:1544417552627802212>",
  boarding: "<:icons_ticket:1544417593191047179>",
  flight: "<:icons_globe:1544417296703815710>",
  clock: "<:icons_clock:1544417185336664114>",
  trade: "<:icons_swap:1544418225503084695>",
  market: "<:icons_store:1544417437666119781>",
  rank: "<:icons_award:1544417478912770127>",
  trophy: "<:icons_trophy:1544418249721126922>",
  sets: "<:icons_bookmark:1544417534562795570>",
  star: "<:icons_star:1544417435636080741>",
  repaint: "<:icons_paintpadbrush:1544417365394071703>",
  upgrade: "<:icons_growth:1544417796631302164>",
  salvage: "<:icons_hammer:1544417299937763348>",
  craft: "<:icons_magicwand:1544417336168288296>",
  locked: "<:icons_locked:1544417721612247171>",
  success: "<:icons_Correct:1544417199798886530>",
  error: "<:icons_Wrong:1544417460638457937>",
  streak: "<:icons_fire:1544417280375525437>",
  hangar: "<:icons_archive:1544417474823590008>",
  info: "<:icons_info:1544417307311341680>",
  left: "<:icons_leftarrow:1544417561008144484>",
  right: "<:icons_rightarrow:1544417401180000337>",
} as const;

/** { id, name } for ButtonBuilder.setEmoji from a "<:name:id>" string. */
export function buttonEmoji(emoji: string): { id: string; name: string } {
  const match = /^<a?:(\w+):(\d+)>$/.exec(emoji);
  return match ? { name: match[1]!, id: match[2]! } : { name: "icons_info", id: "1544417307311341680" };
}
