import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import {
  configEditorLinkRow,
  configEditorWithSupportRow,
  docsPageUrl,
  EDITOR_URL,
  SITE_URL,
  SUPPORT_URL,
} from "../../core/docsUrl.js";
import { resultReply, embedWithFilesReply, guildResultOptions } from "../../core/responses.js";
import { buildResultEmbed } from "../../core/embeds.js";
import { configManager } from "../../config/manager.js";
import { permissionsCommand } from "./commands/permissions.js";
import { pluginCommand } from "./commands/plugin.js";

const EDITOR_HINT =
  "Edit in the [config editor](https://www.dreamliner.site/editor): upload or paste **this server's current YAML** first (from `/config download`), then download your changes and run `/config upload`.";

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
        )
        .addSubcommand((sub) =>
          sub
            .setName("editor")
            .setDescription("How to edit your config in the Dreamliner website editor"),
        ),
      execute: async ({ interaction, guildConfig, client, ephemeral }) => {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId!;
        const resultOptions = guildResultOptions(client, guildConfig);
        const editorComponents = [configEditorWithSupportRow()];

        if (sub === "editor") {
          await interaction.reply(
            resultReply(
              "Config editor",
              [
                "Use the website editor to change your server YAML, then upload it back here.",
                "",
                "**1.** Run `/config download` to get this server's current config (or `/config template` if you're setting up for the first time).",
                "**2.** Open the config editor and click **Upload** or **Paste** — load **your** YAML, not a blank file, so you keep existing settings.",
                "**3.** Edit plugins and fields in the editor, then **Download** or **Copy** the YAML.",
                "**4.** Run `/config upload` with that file to apply it. Optionally `/config validate` first.",
                "",
                `Editor: ${EDITOR_URL}`,
                `Docs: ${docsPageUrl("configuration")}`,
                `Site: ${SITE_URL}`,
                `Support: ${SUPPORT_URL}`,
              ].join("\n"),
              ephemeral,
              resultOptions,
              editorComponents,
            ),
          );
          return;
        }

        if (sub === "download") {
          const yaml = await configManager.getDownloadYaml(guildId);
          const file = new AttachmentBuilder(Buffer.from(yaml, "utf-8"), {
            name: `dreamliner-${guildId}.yaml`,
          });
          await interaction.reply(
            embedWithFilesReply(
              buildResultEmbed(
                "Configuration download",
                `Your current server configuration is attached.\n\n${EDITOR_HINT}`,
                resultOptions,
              ),
              [file],
              ephemeral,
              [configEditorLinkRow()],
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
              buildResultEmbed(
                "Configuration template",
                [
                  "The default configuration template is attached.",
                  "",
                  "Open the [config editor](https://www.dreamliner.site/editor), upload or paste this template, customize it, download the YAML, then run `/config upload`.",
                  "If this server already has a config, prefer `/config download` so you edit the live file instead of starting over.",
                ].join("\n"),
                resultOptions,
              ),
              [file],
              ephemeral,
              [configEditorLinkRow()],
            ),
          );
          return;
        }

        if (sub === "update") {
          const result = await configManager.updateGuildConfigFromDefaults(guildId, interaction.user.id);
          if (!result.success) {
            await interaction.reply(
              resultReply("Configuration update failed", result.errors.join("\n"), ephemeral, {
                ...resultOptions,
                tone: "error",
              }, editorComponents),
            );
            return;
          }

          const note = result.usedLegacyDiff
            ? "New defaults applied using diff detection. Re-uploading your config via `/config upload` improves future updates."
            : "Unchanged settings now match the latest Dreamliner defaults. Your customizations were preserved.";

          await interaction.reply(
            resultReply(
              "Configuration updated",
              `${note}\n\nNeed more edits? ${EDITOR_HINT}`,
              ephemeral,
              { ...resultOptions, tone: "success" },
              [configEditorLinkRow()],
            ),
          );
          return;
        }

        const attachment = interaction.options.getAttachment("file", true);
        if (!attachment.name?.endsWith(".yaml") && !attachment.name?.endsWith(".yml")) {
          await interaction.reply(
            resultReply("Invalid file", "Please upload a `.yaml` or `.yml` file.", ephemeral, {
              ...resultOptions,
              tone: "error",
            }, editorComponents),
          );
          return;
        }

        const response = await fetch(attachment.url);
        const yamlText = await response.text();

        if (sub === "validate") {
          const result = await configManager.validateOnly(yamlText);
          if (!result.success) {
            await interaction.reply(
              resultReply(
                "Configuration invalid",
                `${result.errors.join("\n")}\n\nFix it in the [config editor](https://www.dreamliner.site/editor) (upload this file there), then validate again.`,
                ephemeral,
                { ...resultOptions, tone: "error" },
                editorComponents,
              ),
            );
            return;
          }
          await interaction.reply(
            resultReply(
              "Configuration valid",
              "No errors were found. Run `/config upload` with this file to apply it, or keep editing in the website editor.",
              ephemeral,
              { ...resultOptions, tone: "success" },
              [configEditorLinkRow()],
            ),
          );
          return;
        }

        if (sub === "upload") {
          const result = await configManager.saveGuildConfig(guildId, yamlText, interaction.user.id);
          if (!result.success) {
            await interaction.reply(
              resultReply(
                "Configuration save failed",
                `${result.errors.join("\n")}\n\nUpload the file into the [config editor](https://www.dreamliner.site/editor) to fix errors, then download and try \`/config upload\` again.`,
                ephemeral,
                { ...resultOptions, tone: "error" },
                editorComponents,
              ),
            );
            return;
          }

          await interaction.reply(
            resultReply(
              "Configuration saved",
              "Your server configuration has been applied.\n\nLater changes: `/config download` → edit in the website editor → `/config upload`.",
              ephemeral,
              { ...resultOptions, tone: "success" },
              [configEditorLinkRow()],
            ),
          );
          return;
        }

        return;
      },
    },
    permissionsCommand,
    pluginCommand,
  ],
});
