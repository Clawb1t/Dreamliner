import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, replyWithError, slashResultOptions } from "../../core/responses.js";
import { getLogger } from "../../core/logger.js";
import type { ImageSource } from "../../config/schemas/images.js";
import { fetchImage, IMAGE_SOURCE_LABELS } from "./functions/sources.js";
import { anotherImageRow, imagePayload } from "./functions/render.js";

const log = getLogger("images");

export const imagesCommands: SlashCommandDefinition[] = [
  {
    plugin: "images",
    data: new SlashCommandBuilder()
      .setName("image")
      .setDescription("Post a random image")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Which kind of image")
          .setRequired(true)
          .addChoices(
            { name: "Anime (nekos.best)", value: "anime" },
            { name: "Blåhaj (transgirl.wamellow.com)", value: "blahaj" },
            { name: "Cat (TheCatAPI)", value: "cat" },
            { name: "Dog (Dog CEO)", value: "dog" },
            { name: "Fox (RandomFox)", value: "fox" },
            { name: "Duck (random-d.uk)", value: "duck" },
            { name: "Capybara (capy.lol)", value: "capybara" },
            { name: "Bird (AlexFlipnote)", value: "bird" },
          ),
      ),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "images", "can_use");
      if (!auth) return;

      const source = ctx.interaction.options.getString("type", true) as ImageSource;
      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      try {
        const image = await fetchImage(source);
        await ctx.interaction.editReply(
          imagePayload(source, IMAGE_SOURCE_LABELS[source], image, false, anotherImageRow(source, ctx.interaction.user.id)),
        );
      } catch (err) {
        log.warn(`Image fetch failed (${source}):`, err);
        await replyWithError(
          ctx.interaction,
          ctx.t("images.fetchFailed", "Couldn't fetch an image right now. Try again in a moment."),
          slashResultOptions(ctx),
        );
      }
    },
  },
];
