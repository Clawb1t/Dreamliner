import { ChannelType, SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { baseEmbed } from "../../core/embeds.js";
import { getAccountVoiceUrl, siteLinkRow } from "../../core/docsUrl.js";
import { listPiperVoiceOptions } from "./functions/piper.js";
import { setUserVoice } from "./functions/userVoice.js";

/** Suggests voices from the installed Piper voice directory, shown by human-readable label. */
export async function handleTtsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "voice") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "").toLowerCase();
  const options = await listPiperVoiceOptions();
  const matches = options
    .filter((voice) => voice.id.toLowerCase().includes(query) || voice.label.toLowerCase().includes(query))
    .slice(0, 25);
  await interaction.respond(matches.map((voice) => ({ name: voice.label.slice(0, 100), value: voice.id })));
}

export const ttsCommands: SlashCommandDefinition[] = [
  {
    plugin: "tts",
    data: new SlashCommandBuilder()
      .setName("tts")
      .setDescription("Text-to-speech: pick your voice, or set the auto-speak text channel")
      .addSubcommand((sub) =>
        sub
          .setName("voice")
          .setDescription("Pick which voice your messages are spoken in")
          .addStringOption((o) =>
            o.setName("voice").setDescription("Voice to use").setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("channel")
          .setDescription("Configure the auto-speak text channel")
          .addSubcommand((sub) =>
            sub
              .setName("set")
              .setDescription("Set the channel where messages get spoken into the sender's voice channel")
              .addChannelOption((o) =>
                o
                  .setName("channel")
                  .setDescription("Text channel to use")
                  .addChannelTypes(ChannelType.GuildText)
                  .setRequired(true),
              ),
          )
          .addSubcommand((sub) => sub.setName("clear").setDescription("Turn off the auto-speak text channel")),
      ),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(true);

      if (!group && sub === "voice") {
        const auth = await requirePluginPermission(ctx, "tts", "can_speak");
        if (!auth) return;

        const voice = interaction.options.getString("voice", true);
        const available = await listPiperVoiceOptions();
        const match = available.find((v) => v.id === voice);
        if (!match) {
          await interaction.reply(
            resultReply("Unknown voice", `"${voice}" isn't an installed voice. Pick one from the autocomplete list.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })),
          );
          return;
        }

        await setUserVoice(interaction.user.id, voice);
        const base = resultReply(
          "Voice set",
          `Your messages will now be spoken as **${match.label}**.`,
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "success" }),
        );
        const dashboardEmbed = baseEmbed().setDescription(
          "Prefer to browse and listen first? The web dashboard lets you preview every installed voice before picking one.",
        );
        await interaction.reply({
          ...base,
          embeds: [...(base.embeds ?? []), dashboardEmbed],
          components: [siteLinkRow({ label: "Open voice picker", url: getAccountVoiceUrl() })],
        });
        return;
      }

      if (group === "channel" && sub === "set") {
        const auth = await requirePluginPermission(ctx, "tts", "can_manage_channel");
        if (!auth) return;

        const channel = interaction.options.getChannel("channel", true);
        const result = await ctx.configManager.patchPluginConfig(interaction.guildId!, "tts", { text_channel_id: channel.id }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await interaction.reply(
          resultReply(
            "Channel set",
            `Messages sent in <#${channel.id}> from members in a voice channel will now be spoken there automatically.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success" }),
          ),
        );
        return;
      }

      if (group === "channel" && sub === "clear") {
        const auth = await requirePluginPermission(ctx, "tts", "can_manage_channel");
        if (!auth) return;

        const result = await ctx.configManager.patchPluginConfig(interaction.guildId!, "tts", { text_channel_id: null }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await interaction.reply(resultReply("Channel cleared", "The auto-speak text channel is turned off.", ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
