import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { SlashCommandBuilder, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, resultReply, resultEdit, slashResultOptions } from "../../core/responses.js";
import { getClipUrl, getClipsGalleryUrl, siteLinkRow } from "../../core/docsUrl.js";
import { getDb } from "../../db/client.js";
import { voiceClips, voiceClipParticipants } from "../../db/schema.js";
import { getLogger } from "../../core/logger.js";
import { CLIP_DURATION_CHOICES_SECONDS } from "../../config/schemas/clipping.js";
import { getSession, startClipping, stopRecording } from "./functions/session.js";
import { playClipChime, playClipFailedChime } from "./functions/notify.js";
import { mixWindow } from "./functions/mixer.js";
import { exportClip } from "./functions/export.js";
import { transcribeClipAudio } from "./functions/transcribe.js";
import type { OpusFrame } from "./functions/buffer.js";

const log = getLogger("clipping");

const DURATION_LABELS: Record<number, string> = {
  30: "30 seconds",
  60: "1 minute",
  120: "2 minutes",
  240: "4 minutes",
  300: "5 minutes",
};

// Derived from the same constant the config schema's clip_max_seconds is built from, so the
// command's choices and the config's allowed ceiling can never drift apart.
const TIME_CHOICES = CLIP_DURATION_CHOICES_SECONDS.map((seconds) => ({
  name: DURATION_LABELS[seconds] ?? `${seconds} seconds`,
  value: String(seconds),
}));

function pluginNumber(pluginConfig: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(pluginConfig[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const clippingCommands: SlashCommandDefinition[] = [
  {
    plugin: "clipping",
    data: new SlashCommandBuilder()
      .setName("clipping")
      .setDescription("Record and manage voice channel clips")
      .addSubcommand((sub) => sub.setName("start").setDescription("Start recording this voice channel"))
      .addSubcommand((sub) => sub.setName("stop").setDescription("Stop recording, but keep the bot in the voice channel"))
      .addSubcommand((sub) => sub.setName("clips").setDescription("Get a link to your Dreamliner Clips page")),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const sub = interaction.options.getSubcommand(true);

      if (sub === "start") {
        const auth = await requirePluginPermission(ctx, "clipping", "can_record");
        if (!auth) return;

        const member = auth.member as GuildMember;
        const channel = member.voice.channel;
        if (!channel) {
          await interaction.reply(
            resultReply(
              ctx.t("clipping.startTitle", "Start recording"),
              ctx.t("clipping.notInVoiceBody", "You need to be in a voice channel to start recording."),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        const maxBufferSeconds = pluginNumber(auth.pluginConfig, "clip_max_seconds", 300);
        const result = await startClipping(channel, interaction.user.id, maxBufferSeconds);

        if (!result.ok) {
          const body =
            result.reason === "busy_elsewhere"
              ? ctx.t("clipping.busyElsewhereBody", "Already recording in another voice channel in this server.")
              : ctx.t("clipping.joinFailedBody", "Couldn't join that voice channel.");
          await interaction.reply(
            resultReply(ctx.t("clipping.startTitle", "Start recording"), body, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

        const body = result.resumed
          ? ctx.t("clipping.resumedBody", "Resumed recording **{channel}**. Use /clip any time to export the last bit of it.", {
              channel: channel.name,
            })
          : ctx.t("clipping.startedBody", "Now recording **{channel}**. Use /clip any time to export the last bit of it.", {
              channel: channel.name,
            });
        await interaction.reply(
          resultReply(
            ctx.t("clipping.startTitle", "Start recording"),
            body,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_mic:1544417343252201552>" }),
          ),
        );
        return;
      }

      if (sub === "stop") {
        const auth = await requirePluginPermission(ctx, "clipping", "can_record");
        if (!auth) return;

        const result = stopRecording(interaction.guildId!);
        if (!result.ok) {
          await interaction.reply(
            resultReply(
              ctx.t("clipping.stopTitle", "Stop recording"),
              ctx.t("clipping.notCurrentlyRecordingBody", "Nobody's recording in this server right now."),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        await interaction.reply(
          resultReply(
            ctx.t("clipping.stopTitle", "Stop recording"),
            ctx.t(
              "clipping.stoppedBody",
              "Stopped recording. Dreamliner will stay in the voice channel for 15 minutes in case you want to start again, then leave on its own.",
            ),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_speakermute:1544417589592203375>" }),
          ),
        );
        return;
      }

      if (sub === "clips") {
        await interaction.reply(
          resultReply(
            ctx.t("clipping.clipsTitle", "Dreamliner Clips"),
            ctx.t("clipping.clipsBody", "See every clip you've captured, and every clip you appear in."),
            ctx.ephemeral,
            slashResultOptions(ctx),
            [siteLinkRow({ label: ctx.t("clipping.openClipsLabel", "Open Dreamliner Clips"), url: getClipsGalleryUrl() })],
          ),
        );
      }
    },
  },
  {
    plugin: "clipping",
    permission: "can_clip",
    data: new SlashCommandBuilder()
      .setName("clip")
      .setDescription("Export a clip of recent voice activity")
      .addStringOption((o) =>
        o.setName("time").setDescription("How much of the recent recording to capture (default: 30 seconds)").addChoices(...TIME_CHOICES),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "clipping", "can_clip");
      if (!auth) return;

      const { interaction } = ctx;
      const member = auth.member as GuildMember;
      const channel = member.voice.channel;
      if (!channel) {
        await interaction.reply(
          resultReply(
            ctx.t("clipping.clipTitle", "Clip"),
            ctx.t("clipping.notInVoiceBody", "You need to be in a voice channel to start recording."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const session = getSession(interaction.guildId!);
      if (!session || session.channelId !== channel.id || !session.recording) {
        await interaction.reply(
          resultReply(
            ctx.t("clipping.clipTitle", "Clip"),
            ctx.t("clipping.notRecordingBody", "Nobody's recording this voice channel. Start with /clipping start first."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const maxBufferSeconds = pluginNumber(auth.pluginConfig, "clip_max_seconds", 300);
      const requestedSeconds = Number(interaction.options.getString("time") ?? "30");
      const windowSeconds = Math.min(requestedSeconds, maxBufferSeconds);
      const windowMs = windowSeconds * 1000;
      const windowStart = Date.now() - windowMs;

      await interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      playClipChime(session.player);

      const perUserFrames = new Map<string, OpusFrame[]>();
      for (const [userId, buffer] of session.buffers) {
        const frames = buffer.getFramesInWindow(windowMs);
        if (frames.length > 0) perUserFrames.set(userId, frames);
      }

      if (perUserFrames.size === 0) {
        await interaction.editReply(
          resultEdit(
            ctx.t("clipping.clipTitle", "Clip"),
            ctx.t("clipping.nothingCapturedBody", "Nobody's spoken in the last {seconds}s, so there's nothing to clip yet.", {
              seconds: windowSeconds,
            }),
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      try {
        const mixedPcm = mixWindow(perUserFrames, windowStart, windowMs);

        const participants = await Promise.all(
          [...perUserFrames.keys()].map(async (userId) => {
            const guildMember = await channel.guild.members.fetch(userId).catch(() => null);
            return {
              userId,
              displayName: guildMember?.displayName ?? userId,
              username: guildMember?.user.username ?? userId,
              avatarUrl: guildMember?.displayAvatarURL({ size: 256, extension: "png" }) ?? null,
            };
          }),
        );

        const clipId = randomUUID();
        const exported = await exportClip({
          guildId: interaction.guildId!,
          clipId,
          pcm: mixedPcm,
        });

        const retentionDays = pluginNumber(auth.pluginConfig, "retention_days", 30);
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);

        const db = getDb();
        await db.insert(voiceClips).values({
          id: clipId,
          guildId: interaction.guildId!,
          channelId: channel.id,
          ownerId: interaction.user.id,
          durationMs: windowMs,
          fileName: exported.fileName,
          byteSize: exported.byteSize,
          createdAt,
          expiresAt,
        });
        if (participants.length > 0) {
          await db.insert(voiceClipParticipants).values(
            participants.map((p) => ({
              clipId,
              userId: p.userId,
              displayName: p.displayName,
              username: p.username,
              avatarUrl: p.avatarUrl,
            })),
          );
        }

        await interaction.editReply(
          resultEdit(
            ctx.t("clipping.clipReadyTitle", "Clip ready"),
            ctx.t("clipping.clipReadyBody", "Captured the last {seconds}s: {url}", { seconds: windowSeconds, url: getClipUrl(clipId) }),
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_mic:1544417343252201552>" }),
          ),
        );

        // Fire-and-forget: transcription can take a while and a missing transcript is always an
        // acceptable degraded state, so it must never hold up the reply above.
        void transcribeClipAudio(mixedPcm)
          .then(async (segments) => {
            if (!segments) return;
            await db.update(voiceClips).set({ transcript: JSON.stringify(segments) }).where(eq(voiceClips.id, clipId));
          })
          .catch((err) => log.error(`Transcription failed for clip ${clipId}:`, err));
      } catch (err) {
        log.error(`/clip export failed in guild ${interaction.guildId}:`, err);
        try {
          // The session may have been torn down mid-export (channel emptied, /clipping stop) —
          // the reply below still tells the user either way, so a chime failure here shouldn't
          // mask the real error.
          playClipFailedChime(session.player);
        } catch {
          // Ignore — see above.
        }
        await interaction.editReply(
          resultEdit(
            ctx.t("clipping.clipTitle", "Clip"),
            ctx.t("clipping.exportFailedBody", "Something went wrong exporting that clip. Try again in a moment."),
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
      }
    },
  },
];
