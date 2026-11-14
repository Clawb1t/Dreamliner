import { ButtonBuilder, ButtonStyle, ActionRowBuilder, SlashCommandBuilder, type MessageActionRowComponentBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { getIdentityCardUrl } from "../../core/docsUrl.js";

const FINGERPRINT_EMOJI = "<:icons_fingerprint:1544418020682899537>";

export const memberIdentityCommands: SlashCommandDefinition[] = [
  {
    // No can_* flag: anyone in the server can open anyone's card there. The plugin-enabled check
    // runs in dispatch, and the website checks the viewer is in the server before showing data.
    plugin: "member_identity",
    data: new SlashCommandBuilder()
      .setName("identity")
      .setDescription("Open a member's identity card: what Dreamliner saved and what comes back on rejoin")
      .addUserOption((o) => o.setName("user").setDescription("Whose card to open (default: you)")),
    execute: async (ctx) => {
      const { interaction } = ctx;
      const guildId = interaction.guildId!;
      const target = interaction.options.getUser("user") ?? interaction.user;
      const self = target.id === interaction.user.id;

      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(ctx.t("member_identity.openCardLabel", "Open identity card"))
        .setURL(getIdentityCardUrl(guildId, target.id));

      await interaction.reply(
        resultReply(
          ctx.t("member_identity.cardTitle", "Identity card"),
          self
            ? ctx.t(
                "member_identity.cardBodySelf",
                "See what Dreamliner has saved about you in this server, and what comes back if you leave and rejoin.",
              )
            : ctx.t(
                "member_identity.cardBodyOther",
                "See what Dreamliner has saved about <@{id}> in this server, and what comes back if they leave and rejoin.",
                { id: target.id },
              ),
          true,
          slashResultOptions(ctx, { emoji: FINGERPRINT_EMOJI }),
          [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(button)],
        ),
      );
    },
  },
];
