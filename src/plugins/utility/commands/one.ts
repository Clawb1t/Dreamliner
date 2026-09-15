import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { getDreamlinerOnePublicStatus } from "../../../bridge/dreamlinerOne.js";
import {
  DREAMLINER_ONE_APPLICATION_ID,
  getConfiguredOneSkuId,
} from "../../../bridge/oneEntitlements.js";
import { getGuildDashboardUrl, getSiteUrl } from "../../../core/docsUrl.js";
import { requireUtilityPermission } from "../functions/commandHelpers.js";
import { discordTimestamp } from "../functions/time.js";

/** Kept in sync by hand with the website's DREAMLINER_ONE_PRICE — there's no shared package
 * between the two repos, and this is the one place the bot needs to display it. */
const DREAMLINER_ONE_PRICE = "$1.99/month";

export const oneCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_one",
    data: new SlashCommandBuilder()
      .setName("one")
      .setDescription("Check whether Dreamliner One is active for this server, or subscribe"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_one");
      if (!auth) return;

      const guildId = ctx.interaction.guildId;
      if (!guildId) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("utility.one.title", "Dreamliner One"),
            ctx.t("utility.one.serverOnlyBody", "This command only works in a server."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      const status = await getDreamlinerOnePublicStatus(guildId);
      const dashboardUrl = getGuildDashboardUrl(guildId);

      if (status.active) {
        const expiryLine = status.forever
          ? ctx.t("utility.one.doesntExpire", "Doesn't expire")
          : status.expiresAt
            ? discordTimestamp(new Date(status.expiresAt), "R")
            : ctx.t("utility.one.activeWord", "Active");

        const embed = setEmbedAuthor(
          baseEmbed(),
          ctx.t("utility.one.title", "Dreamliner One"),
          ctx.client,
          commandHeader(ctx.guildConfig, { tone: "success" }),
        ).addFields(
          embedField(ctx.t("utility.one.statusLabel", "Status"), ctx.t("utility.one.activeWord", "Active"), true),
          embedField(ctx.t("utility.one.renewsExpiresLabel", "Renews / expires"), expiryLine, true),
          ...(status.note ? [embedField(ctx.t("utility.one.noteLabel", "Note"), status.note)] : []),
        );

        await ctx.interaction.reply(
          embedReply(embed, ctx.ephemeral, [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setLabel(ctx.t("utility.one.manageInDashboard", "Manage in dashboard"))
                .setStyle(ButtonStyle.Link)
                .setURL(dashboardUrl),
            ),
          ]),
        );
        return;
      }

      const embed = setEmbedAuthor(
        baseEmbed(),
        ctx.t("utility.one.title", "Dreamliner One"),
        ctx.client,
        commandHeader(ctx.guildConfig, { tone: "neutral" }),
      ).addFields(
        embedField(ctx.t("utility.one.statusLabel", "Status"), ctx.t("utility.one.notActive", "Not active"), true),
        embedField(ctx.t("utility.one.priceLabel", "Price"), DREAMLINER_ONE_PRICE, true),
        embedField(
          ctx.t("utility.one.whatYouGetLabel", "What you get"),
          ctx.t("utility.one.whatYouGetBody", "Custom bot avatar, banner, nickname, and bio, plus automatic message translation, unlocked for this server."),
        ),
      );

      // A Premium/SKU button only works when the SKU belongs to the exact same Discord
      // application as the bot sending it — Discord rejects the whole message otherwise
      // (BUTTON_COMPONENT_INVALID_APPLICATION). That's always true for the production
      // Dreamliner bot, but never true for a dev/test bot running under a different
      // application, so check first instead of letting the reply fail outright.
      const canShowPurchaseButton = ctx.client.application?.id === DREAMLINER_ONE_APPLICATION_ID;
      const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(canShowPurchaseButton ? ctx.t("utility.one.learnMore", "Learn more") : ctx.t("utility.one.subscribeOnWebsite", "Subscribe on the website"))
          .setStyle(ButtonStyle.Link)
          .setURL(`${getSiteUrl()}/one`),
      );

      const rows = canShowPurchaseButton
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(getConfiguredOneSkuId()),
            ),
            linkRow,
          ]
        : [linkRow];

      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral, rows));
    },
  },
];
