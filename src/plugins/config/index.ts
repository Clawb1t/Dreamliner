import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { resultReply, embedWithFilesReply, guildResultOptions } from "../../core/responses.js";
import { buildResultEmbed } from "../../core/embeds.js";
import { configManager } from "../../config/manager.js";

export const configPlugin = definePlugin({
  name: "config",
  slashCommands: [
    {
      plugin: "config",
      manageServer: true,
      data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("Manage Dreamliner server configuration")
        .addSubcommand((sub) =>
          sub.setName("download").setDescription("Download the current server configuration"),
        )
        .addSubcommand((sub) =>
          sub.setName("template").setDescription("Download the default configuration template"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("upload")
            .setDescription("Upload an edited configuration file")
            .addAttachmentOption((opt) =>
              opt.setName("file").setDescription("YAML configuration file").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("validate")
            .setDescription("Validate a configuration file without saving")
            .addAttachmentOption((opt) =>
              opt.setName("file").setDescription("YAML configuration file").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("update")
            .setDescription("Apply new Dreamliner defaults while keeping your customizations"),
        ),
      execute: async ({ interaction, guildConfig, client, ephemeral }) => {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId!;
        const resultOptions = guildResultOptions(client, guildConfig);

        if (sub === "download") {
          const yaml = await configManager.getDownloadYaml(guildId);
          const file = new AttachmentBuilder(Buffer.from(yaml, "utf-8"), {
            name: `dreamliner-${guildId}.yaml`,
          });
          await interaction.reply(
            embedWithFilesReply(
              buildResultEmbed("Configuration download", "Your current server configuration is attached.", resultOptions),
              [file],
              ephemeral,
            ),
          );
          return;
        }

        if (sub === "template") {
          const yaml = configManager.getTemplateYaml();
          const file = new AttachmentBuilder(Buffer.from(yaml, "utf-8"), {
            name: "dreamliner-template.yaml",
          });
          await interaction.reply(
            embedWithFilesReply(
              buildResultEmbed("Configuration template", "The default configuration template is attached.", resultOptions),
              [file],
              ephemeral,
            ),
          );
          return;
        }

        if (sub === "update") {
          const result = await configManager.updateGuildConfigFromDefaults(guildId, interaction.user.id);
          if (!result.success) {
            await interaction.reply(
              resultReply("Configuration update failed", result.errors.join("\n"), ephemeral, { ...resultOptions, tone: "error" }),
            );
            return;
          }

          const note = result.usedLegacyDiff
            ? "New defaults applied using diff detection. Re-uploading your config via `/config upload` improves future updates."
            : "Unchanged settings now match the latest Dreamliner defaults. Your customizations were preserved.";

          await interaction.reply(resultReply("Configuration updated", note, ephemeral, { ...resultOptions, tone: "success" }));
          return;
        }

        const attachment = interaction.options.getAttachment("file", true);
        if (!attachment.name?.endsWith(".yaml") && !attachment.name?.endsWith(".yml")) {
          await interaction.reply(resultReply("Invalid file", "Please upload a `.yaml` or `.yml` file.", ephemeral, { ...resultOptions, tone: "error" }));
          return;
        }

        const response = await fetch(attachment.url);
        const yamlText = await response.text();

        if (sub === "validate") {
          const result = await configManager.validateOnly(yamlText);
          if (!result.success) {
            await interaction.reply(
              resultReply("Configuration invalid", result.errors.join("\n"), ephemeral, { ...resultOptions, tone: "error" }),
            );
            return;
          }
          await interaction.reply(resultReply("Configuration valid", "No errors were found.", ephemeral, { ...resultOptions, tone: "success" }));
          return;
        }

        if (sub === "upload") {
          const result = await configManager.saveGuildConfig(guildId, yamlText, interaction.user.id);
          if (!result.success) {
            await interaction.reply(
              resultReply("Configuration save failed", result.errors.join("\n"), ephemeral, { ...resultOptions, tone: "error" }),
            );
            return;
          }

          await interaction.reply(
            resultReply("Configuration saved", "Your server configuration has been applied.", ephemeral, { ...resultOptions, tone: "success" }),
          );
          return;
        }

        return;
      },
    },
  ],
});
