import { SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { zTtsConfig } from "../../config/schemas/tts.js";
import { parsePluginConfig } from "../../core/pluginSchemas.js";
import { synthesize } from "./functions/synth.js";
import { speakInChannel } from "./functions/session.js";
import { listPiperVoices } from "./functions/piper.js";

/** Per-member cooldown tracker, keyed `${guildId}:${userId}`. Cleared on process restart. */
const lastUse = new Map<string, number>();

/** Suggests voices from the installed Piper voice directory. */
export async function handleTtsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "voice") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "").toLowerCase();
  const options = await listPiperVoices();
  const matches = options.filter((voice) => voice.toLowerCase().includes(query)).slice(0, 25);
  await interaction.respond(matches.map((voice) => ({ name: voice, value: voice })));
}

export const ttsCommands: SlashCommandDefinition[] = [
  {
    plugin: "tts",
    data: new SlashCommandBuilder()
      .setName("tts")
      .setDescription("Make Dreamliner join your voice channel and speak text aloud")
      .addStringOption((o) =>
        o.setName("text").setDescription("Text to speak").setRequired(true).setMaxLength(500),
      )
      .addStringOption((o) =>
        o
          .setName("voice")
          .setDescription("Voice to use (defaults to the server's configured voice)")
          .setAutocomplete(true),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "tts", "can_speak");
      if (!auth) return;

      const { interaction } = ctx;
      const config = parsePluginConfig(zTtsConfig, auth.pluginConfig);

      const voiceChannel = auth.member.voice.channel;
      if (!voiceChannel) {
        await interaction.reply(
          resultReply("Join a voice channel", "You need to be in a voice channel to use `/tts`.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
        );
        return;
      }

      const text = interaction.options.getString("text", true).trim();
      if (!text) {
        await interaction.reply(
          resultReply("Nothing to say", "Give me some text to speak.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
        );
        return;
      }

      const maxChars = config.max_characters;
      if (text.length > maxChars) {
        await interaction.reply(
          resultReply(
            "Too long",
            `Keep it under **${maxChars}** characters (this one is ${text.length}).`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const cooldownSeconds = config.cooldown_seconds;
      const cooldownKey = `${interaction.guildId}:${interaction.user.id}`;
      const now = Date.now();
      const elapsed = now - (lastUse.get(cooldownKey) ?? 0);
      const remainingMs = cooldownSeconds * 1000 - elapsed;
      if (remainingMs > 0) {
        await interaction.reply(
          resultReply(
            "Slow down",
            `Wait **${Math.ceil(remainingMs / 1000)}s** before using \`/tts\` again.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      await interaction.deferReply({ ephemeral: ctx.ephemeral });

      const requestedVoice = interaction.options.getString("voice");
      const speech = await synthesize(text, config, requestedVoice);
      if ("error" in speech) {
        await interaction.editReply(resultEdit("Text-to-speech failed", speech.error, slashResultOptions(ctx, { tone: "error" })));
        return;
      }

      const spoken = await speakInChannel(voiceChannel, speech.audio);
      if (!spoken.ok) {
        const message =
          spoken.reason === "busy_elsewhere"
            ? "Dreamliner is already speaking in another voice channel in this server. Try again shortly."
            : "Could not join your voice channel. Check that Dreamliner has permission to connect and speak there.";
        await interaction.editReply(resultEdit("Could not speak", message, slashResultOptions(ctx, { tone: "error" })));
        return;
      }

      lastUse.set(cooldownKey, now);
      await interaction.editReply(
        resultEdit("Speaking", `Speaking in ${voiceChannel}: "${text.length > 200 ? `${text.slice(0, 200)}…` : text}"`, slashResultOptions(ctx)),
      );
    },
  },
];
