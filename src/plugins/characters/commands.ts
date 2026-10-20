import { PermissionFlagsBits, SlashCommandBuilder, type AutocompleteInteraction, type GuildMember } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { containerReply, resultReply, slashResultOptions } from "../../core/responses.js";
import { buildResultEmbed } from "../../core/embeds.js";
import { getGuildDashboardUrl, siteLinkRow } from "../../core/docsUrl.js";
import { CHARACTER_EMOJI, PLUGIN } from "./constants.js";
import { characterAvatarUrl } from "./functions/avatar.js";
import { charactersConfigOf } from "./functions/respond.js";
import { listCharacters, setMemoryReset, type CharacterRecord } from "./functions/store.js";

function howToTalk(character: CharacterRecord, triggers: { reply: boolean; name: boolean; dedicated_channels: boolean }): string {
  const ways: string[] = [];
  if (character.roleId) ways.push(`mention <@&${character.roleId}>`);
  if (triggers.reply) ways.push("reply to its messages");
  if (triggers.name) ways.push("say its name");
  if (triggers.dedicated_channels && character.dedicatedChannelIds.length) {
    ways.push(`talk in ${character.dedicatedChannelIds.map((id) => `<#${id}>`).join(", ")}`);
  }
  return ways.length ? ways.join(" · ") : "Not reachable yet: its role is missing.";
}

export const charactersCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder().setName("characters").setDescription("See this server's AI characters and how to talk to them"),
    execute: async (ctx) => {
      const guildId = ctx.interaction.guildId!;
      const config = charactersConfigOf(ctx.guildConfig);
      const usable = listCharacters(guildId).filter((c) => c.enabled && c.reviewStatus === "approved");
      if (!usable.length) {
        await ctx.interaction.reply(
          resultReply(
            "Characters",
            "This server has no characters yet. Server managers can create them on the dashboard.",
            true,
            slashResultOptions(ctx, { emoji: CHARACTER_EMOJI }),
            [siteLinkRow({ label: "Open dashboard", url: `${getGuildDashboardUrl(guildId)}?section=plugin:characters` })],
          ),
        );
        return;
      }
      const lines = usable.map((c) => {
        const avatar = characterAvatarUrl(guildId, c);
        const title = avatar ? `**[${c.name}](${avatar})**` : `**${c.name}**`;
        return `${title}${c.tagline ? ` - ${c.tagline}` : ""}\n-# ${howToTalk(c, config.triggers)}`;
      });
      const body = `**Characters in this server**\n\n${lines.join("\n\n")}\n\n-# Characters are AI and can make mistakes.`;
      const container = buildResultEmbed("Characters", body.slice(0, 3900), slashResultOptions(ctx, { emoji: CHARACTER_EMOJI }));
      // One character: show its avatar too.
      if (usable.length === 1) container.setThumbnail(characterAvatarUrl(guildId, usable[0]!));
      await ctx.interaction.reply({ ...containerReply(container, ctx.ephemeral), allowedMentions: { parse: [] } });
    },
  },
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("character")
      .setDescription("Manage this server's AI characters")
      .addSubcommand((sub) =>
        sub
          .setName("reset")
          .setDescription("Make a character forget the conversation in this channel")
          .addStringOption((o) =>
            o.setName("character").setDescription("The character").setRequired(true).setAutocomplete(true),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      if (sub !== "reset") return;
      const member = ctx.interaction.member as GuildMember | null;
      const allowed =
        member?.permissions.has(PermissionFlagsBits.ManageMessages) || member?.permissions.has(PermissionFlagsBits.ManageGuild);
      if (!allowed) {
        await ctx.interaction.reply(
          resultReply("Permission denied", "You need **Manage Messages** or **Manage Server** to reset a character.", true, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }
      const guildId = ctx.interaction.guildId!;
      const query = ctx.interaction.options.getString("character", true).trim();
      const all = listCharacters(guildId);
      const character =
        all.find((c) => String(c.id) === query) ?? all.find((c) => c.name.toLowerCase() === query.toLowerCase()) ?? null;
      if (!character) {
        await ctx.interaction.reply(resultReply("Not found", `No character called **${query.slice(0, 80)}**.`, true, slashResultOptions(ctx, { tone: "warning" })));
        return;
      }
      setMemoryReset(character.id, ctx.interaction.channelId);
      await ctx.interaction.reply(
        resultReply(
          "Conversation reset",
          `**${character.name}** has forgotten the conversation in this channel and will start fresh.`,
          true,
          slashResultOptions(ctx, { emoji: CHARACTER_EMOJI }),
        ),
      );
    },
  },
];

/** Autocomplete for /character reset: the server's characters by name. */
export async function handleCharacterAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = listCharacters(interaction.guildId)
    .filter((c) => c.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((c) => ({ name: c.name.slice(0, 100), value: String(c.id) }));
  await interaction.respond(choices);
}
