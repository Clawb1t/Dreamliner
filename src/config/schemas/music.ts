import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

export const MUSIC_FILTER_PRESETS = ["none", "nightcore", "vaporwave", "bassboost", "8d", "karaoke"] as const;
export type MusicFilterPreset = (typeof MUSIC_FILTER_PRESETS)[number];

export const MUSIC_LOOP_MODES = ["off", "track", "queue"] as const;
export type MusicLoopMode = (typeof MUSIC_LOOP_MODES)[number];

export const zMusicConfig = z.strictObject({
  // --- DJ system ---
  dj_roles: z
    .array(z.string())
    .default([])
    .describe(
      "Roles treated as DJs: can force-skip, manage anyone's queue items, and bypass vote-skip. Configurable here or via /music dj.",
    ),
  dj_mode: z
    .boolean()
    .default(false)
    .describe(
      "When enabled, only DJs (and a track's own requester, for their own track) can control playback. When off, anyone with the relevant permission may act directly and vote-skip governs skip requests from everyone else.",
    ),

  // --- Vote-skip ---
  vote_skip_threshold_percent: z
    .number()
    .int()
    .min(10)
    .max(100)
    .default(50)
    .describe(
      "Percentage of non-bot members currently in the voice channel that must vote to skip the current track (rounded up, minimum 1 vote).",
    ),
  vote_skip_timeout_seconds: z
    .number()
    .int()
    .min(10)
    .max(300)
    .default(60)
    .describe("How long a vote-skip stays open before it expires if the threshold isn't reached."),

  // --- Playback defaults / limits ---
  default_volume: z.number().int().min(1).max(150).default(80).describe("Volume (%) a fresh player starts at."),
  max_queue_size: z.number().int().min(10).max(1000).default(200).describe("Maximum tracks allowed in the queue at once."),
  max_track_duration_minutes: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(0)
    .describe("Reject tracks longer than this many minutes. 0 = no limit."),
  allowed_filters: z
    .array(z.enum(MUSIC_FILTER_PRESETS))
    .default([...MUSIC_FILTER_PRESETS])
    .describe("Which /music filter presets members may use on this server."),

  // --- Channel restriction / announce ---
  allowed_voice_channels: z
    .array(z.string())
    .default([])
    .describe("If set, music can only be played in these voice channels. Empty allows any voice channel."),
  allowed_text_channels: z
    .array(z.string())
    .default([])
    .describe("If set, music commands only work in these text channels. Empty allows any channel."),
  announce_now_playing: z
    .boolean()
    .default(false)
    .describe("Post a now-playing message automatically whenever a new track starts."),
  announce_channel_id: channelId(
    "Text channel now-playing announcements are posted to. Falls back to the channel /music play was run in when unset.",
  ),

  // --- 24/7 ---
  stay_connected_247: z
    .boolean()
    .default(false)
    .describe("Keep the bot connected even when the queue is empty and nobody is listening, instead of auto-leaving."),
  auto_leave_empty_seconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(120)
    .describe(
      "Seconds to wait after the voice channel empties of non-bot members before leaving. Ignored when 24/7 is on. 0 leaves immediately.",
    ),

  // --- Permission flags ---
  can_play: boolPerm("queue tracks with /music play and /music search"),
  can_control_playback: boolPerm("pause, resume, seek, adjust volume, and apply filters"),
  can_skip: boolPerm("start or join a vote-skip on the current track"),
  can_force_skip: boolPerm("force-skip immediately without a vote (also implied by DJ status)"),
  can_manage_queue: boolPerm("remove, move, clear, and shuffle queue entries, and set loop mode"),
  can_manage_playlists: boolPerm("save, load, rename, and delete their own saved playlists"),
  can_manage_dj: boolPerm("configure the DJ role list and DJ mode with /music dj"),
  can_manage_settings: boolPerm(
    "configure announce channel, restricted channels, default volume, and 24/7 mode with /musicconfig",
  ),
});

export const zMusicPluginSection = zPluginSection(zMusicConfig.shape, false);

export type MusicConfig = z.infer<typeof zMusicConfig>;
