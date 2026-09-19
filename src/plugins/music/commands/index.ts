import type { SlashCommandDefinition } from "../../../core/types.js";
import { playCommand } from "./play.js";
import { playbackCommands } from "./playback.js";
import { queueCommands } from "./queue.js";
import { connectCommands } from "./connect.js";
import { djCommand } from "./dj.js";
import { playlistCommand } from "./playlist.js";
import { musicConfigCommand } from "./config.js";
import { autoplayCommand } from "./autoplay.js";

export const musicCommands: SlashCommandDefinition[] = [
  playCommand,
  ...playbackCommands,
  ...queueCommands,
  ...connectCommands,
  djCommand,
  playlistCommand,
  musicConfigCommand,
  autoplayCommand,
];
