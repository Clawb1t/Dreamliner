import { ChannelType, SlashCommandBuilder, type AutocompleteInteraction } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { baseEmbed } from "../../core/embeds.js";
import { getAccountVoiceUrl, siteLinkRow } from "../../core/docsUrl.js";
import { listPiperVoiceOptions } from "./functions/piper.js";
import { setUserVoice } from "./functions/userVoice.js";
import { skipCurrent } from "./functions/session.js";
import { addToTtsBlacklist, isTtsBlacklisted, listTtsBlacklist, removeFromTtsBlacklist } from "./functions/blacklist.js";

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
      .setDescription("Text-to-speech: pick your voice, skip a clip, or manage the auto-speak channel")
      .addSubcommand((sub) =>
        sub
          .setName("voice")
          .setDescription("Pick which voice your messages are spoken in")
          .addStringOption((o) =>
            o.setName("voice").setDescription("Voice to use").setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("skip").setDescription("Skip the TTS clip that's currently playing"))
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
      )
      .addSubcommandGroup((group) =>
        group
          .setName("blacklist")
          .setDescription("Block or unblock members from using TTS")
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Block a member from using TTS")
              .addUserOption((o) => o.setName("target").setDescription("Member to block").setRequired(true))
              .addStringOption((o) => o.setName("reason").setDescription("Reason")),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Unblock a member from using TTS")
              .addUserOption((o) => o.setName("target").setDescription("Member to unblock").setRequired(true)),
          )
          .addSubcommand((sub) => sub.setName("list").setDescription("List members blocked from using TTS")),
      ),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const guildId = interaction.guildId!;
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(true);

      if (!group && sub === "voice") {
        const auth = await requirePluginPermission(ctx, "tts", "can_speak");
        if (!auth) return;

        if (await isTtsBlacklisted(guildId, interaction.user.id)) {
          await interaction.reply(
            resultReply("Blocked", "You've been blocked from using TTS on this server.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }

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
          slashResultOptions(ctx, { tone: "success", emoji: "<:icons_mic:1544417343252201552>" }),
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

      if (!group && sub === "skip") {
        const auth = await requirePluginPermission(ctx, "tts", "can_skip");
        if (!auth) return;

        const skipped = skipCurrent(guildId);
        await interaction.reply(
          resultReply(
            skipped ? "Skipped" : "Nothing playing",
            skipped ? "Moving on to the next queued message, if there is one." : "There's no TTS clip playing right now.",
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: skipped ? "success" : "warning",
              emoji: skipped ? "<:icons_frontforward:1544417288885637253>" : undefined,
            }),
          ),
        );
        return;
      }

      if (group === "channel" && sub === "set") {
        const auth = await requirePluginPermission(ctx, "tts", "can_manage_channel");
        if (!auth) return;

        const channel = interaction.options.getChannel("channel", true);
        const result = await ctx.configManager.patchPluginConfig(guildId, "tts", { text_channel_id: channel.id }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await interaction.reply(
          resultReply(
            "Channel set",
            `Messages sent in <#${channel.id}> from members in a voice channel will now be spoken there automatically.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_speaker:1544417584462565417>" }),
          ),
        );
        return;
      }

      if (group === "channel" && sub === "clear") {
        const auth = await requirePluginPermission(ctx, "tts", "can_manage_channel");
        if (!auth) return;

        const result = await ctx.configManager.patchPluginConfig(guildId, "tts", { text_channel_id: null }, interaction.user.id);
        if (!result.success) {
          await interaction.reply(resultReply("Error", result.errors.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
          return;
        }

        await interaction.reply(
          resultReply(
            "Channel cleared",
            "The auto-speak text channel is turned off.",
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_speakermute:1544417589592203375>" }),
          ),
        );
        return;
      }

      if (group === "blacklist" && sub === "add") {
        const auth = await requirePluginPermission(ctx, "tts", "can_blacklist");
        if (!auth) return;

        const target = interaction.options.getUser("target", true);
        const reason = interaction.options.getString("reason");
        await addToTtsBlacklist(guildId, target.id, reason);
        await interaction.reply(
          resultReply(
            "Blocked",
            `${target.tag} can no longer use TTS on this server.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_ban:1544417486177308742>" }),
          ),
        );
        return;
      }

      if (group === "blacklist" && sub === "remove") {
        const auth = await requirePluginPermission(ctx, "tts", "can_blacklist");
        if (!auth) return;

        const target = interaction.options.getUser("target", true);
        await removeFromTtsBlacklist(guildId, target.id);
        await interaction.reply(
          resultReply(
            "Unblocked",
            `${target.tag} can use TTS again.`,
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "success", emoji: "<:icons_enable:1544417874351755264>" }),
          ),
        );
        return;
      }

      if (group === "blacklist" && sub === "list") {
        const auth = await requirePluginPermission(ctx, "tts", "can_blacklist");
        if (!auth) return;

        const entries = await listTtsBlacklist(guildId);
        if (entries.length === 0) {
          await interaction.reply(resultReply("TTS blacklist", "Nobody is blocked from using TTS.", ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        const lines = entries.map((e) => `<@${e.userId}>${e.reason ? ` (${e.reason})` : ""}`);
        await interaction.reply(resultReply("TTS blacklist", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
