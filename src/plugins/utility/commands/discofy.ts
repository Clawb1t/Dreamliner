import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { deferReplyOptions, embedEdit, resultEdit, slashResultOptions } from "../../../core/responses.js";
import { siteLinkRow } from "../../../core/docsUrl.js";
import { requireUtilityPermission } from "../functions/commandHelpers.js";
import {
  DiscofyAssetError,
  getRandomDiscofyAsset,
  searchDiscofyAsset,
  type DiscofyAsset,
  type DiscofyAssetType,
} from "../functions/discofyAssets.js";
import { getLogger } from "../../../core/logger.js";

const log = getLogger("utility");
const DISCOFY_EMOJI = "<:discofy:1548639182358978620>";

export const discofyCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_discofy",
    data: new SlashCommandBuilder()
      .setName("discofy")
      .setDescription("Pull an avatar or banner from Discofy")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Avatar or banner")
          .setRequired(true)
          .addChoices({ name: "Avatar", value: "AVATAR" }, { name: "Banner", value: "BANNER" }),
      )
      .addStringOption((o) =>
        o.setName("search").setDescription("Search for this instead of getting a random one"),
      ),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_discofy");
      if (!auth) return;

      const type = ctx.interaction.options.getString("type", true) as DiscofyAssetType;
      const search = ctx.interaction.options.getString("search")?.trim() || undefined;
      const typeLabel =
        type === "AVATAR" ? ctx.t("utility.discofy.avatarLabel", "Avatar") : ctx.t("utility.discofy.bannerLabel", "Banner");

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      let asset: DiscofyAsset | null;
      try {
        asset = search ? await searchDiscofyAsset(type, search, ctx.t) : await getRandomDiscofyAsset(type, ctx.t);
      } catch (error) {
        log.error("/discofy error:", error);
        const details =
          error instanceof DiscofyAssetError ? error.message : ctx.t("utility.discofy.requestFailed", "Could not reach Discofy.");
        await ctx.interaction.editReply(
          resultEdit(ctx.t("utility.discofy.title", "Discofy"), details, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      if (!asset) {
        const body = search
          ? ctx.t("utility.discofy.noSearchResultsBody", "No {type} matched `{search}` on Discofy.", { type: typeLabel, search })
          : ctx.t("utility.discofy.noRandomResultBody", "Discofy has no {type} to pick from right now.", { type: typeLabel });
        await ctx.interaction.editReply(
          resultEdit(ctx.t("utility.discofy.title", "Discofy"), body, slashResultOptions(ctx, { tone: "warning" })),
        );
        return;
      }

      const embed = setEmbedAuthor(
        baseEmbed(),
        ctx.t("utility.discofy.resultTitle", "Discofy {type}", { type: typeLabel }),
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: DISCOFY_EMOJI }),
      )
        .setImage(asset.fileUrl)
        .addFields(embedField(ctx.t("utility.discofy.typeLabel", "Type"), typeLabel, true));

      if (search) embed.addFields(embedField(ctx.t("utility.discofy.searchLabel", "Search"), search, true));
      if (typeof asset.aesthetic === "string" && asset.aesthetic) {
        embed.addFields(embedField(ctx.t("utility.discofy.aestheticLabel", "Aesthetic"), asset.aesthetic, true));
      }
      if (typeof asset.tag === "string" && asset.tag) {
        embed.addFields(embedField(ctx.t("utility.discofy.tagLabel", "Tag"), asset.tag, true));
      }

      await ctx.interaction.editReply(
        embedEdit(embed, [siteLinkRow({ label: ctx.t("utility.discofy.openOnDiscofyLabel", "Open on Discofy"), url: asset.fileUrl })]),
      );
    },
  },
];
