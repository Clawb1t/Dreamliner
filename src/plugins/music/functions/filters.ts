import type { Player } from "lavalink-client";
import type { MusicFilterPreset } from "../../../config/schemas/music.js";

/** Applies `preset` on top of a clean slate — always resets first so presets don't stack. */
export async function applyFilterPreset(player: Player, preset: MusicFilterPreset): Promise<void> {
  await player.filterManager.resetFilters();
  switch (preset) {
    case "none":
      return;
    case "nightcore":
      await player.filterManager.toggleNightcore();
      return;
    case "vaporwave":
      await player.filterManager.toggleVaporwave();
      return;
    case "karaoke":
      await player.filterManager.toggleKaraoke();
      return;
    case "8d":
      await player.filterManager.toggleRotation();
      return;
    case "bassboost":
      await player.filterManager.setEQPreset("BassboostMedium");
      return;
  }
}
