import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions } from "../../core/responses.js";
import { downloadNekoImage, fetchRandomNeko, nekoUrlToRef, NekosBestError } from "./functions/nekosBest.js";
import { formatNekoContent } from "./functions/format.js";
import { buildNekoSaveRow, buildSavedNavRow } from "./functions/buttons.js";
import { listSavedNekos } from "./functions/store.js";

async function runNeko(ctx: SlashCommandContext): Promise<void> {
  const i = ctx.interaction;
  await i.deferReply(deferReplyOptions(ctx.ephemeral));

  try {
    const neko = await fetchRandomNeko();
    const image = await downloadNekoImage(neko.url);
    const attachment = new AttachmentBuilder(image.buffer, { name: image.filename });
    const row = buildNekoSaveRow(nekoUrlToRef(neko.url));

    await i.editReply({
      content: formatNekoContent(neko.artistName, neko.artistHref, ctx.guildConfig.emojis.success),
      files: [attachment],
      components: [row],
    });
  } catch (error) {
    const message = error instanceof NekosBestError ? error.message : "Couldn't fetch a neko right now.";
    console.error("[anime] /anime neko failed:", error);
    await i.editReply({ content: `${message} Try again in a moment.` });
  }
}

async function runSaved(ctx: SlashCommandContext): Promise<void> {
  const i = ctx.interaction;
  await i.deferReply(deferReplyOptions(ctx.ephemeral));

  const saved = await listSavedNekos(i.user.id);
  if (saved.length === 0) {
    await i.editReply({ content: "You haven't saved any nekos yet — run `/anime neko` and hit **Save**." });
    return;
  }

  const neko = saved[0]!;
  const image = await downloadNekoImage(neko.imageUrl).catch(() => null);

  await i.editReply({
    content: `${formatNekoContent(neko.artistName, neko.artistHref, ctx.guildConfig.emojis.success)}\n-# Saved neko 1/${saved.length}`,
    files: image ? [new AttachmentBuilder(image.buffer, { name: image.filename })] : [],
    components: [buildSavedNavRow(0, saved.length)],
  });
}

export const animeCommands: SlashCommandDefinition[] = [
  {
    plugin: "anime",
    data: new SlashCommandBuilder()
      .setName("anime")
      .setDescription("Anime image commands")
      .addSubcommand((s) => s.setName("neko").setDescription("Get a random neko image"))
      .addSubcommand((s) => s.setName("saved").setDescription("Browse your saved nekos")),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();

      if (sub === "neko") {
        const auth = await requirePluginPermission(ctx, "anime", "can_neko");
        if (!auth) return;
        await runNeko(ctx);
        return;
      }

      const auth = await requirePluginPermission(ctx, "anime", "can_saved");
      if (!auth) return;
      await runSaved(ctx);
    },
  },
];
