import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import {
  configEditorLinkRow,
  configEditorWithSupportRow,
  docsPageUrl,
  getEditorUrl,
  getSiteUrl,
  SUPPORT_URL,
} from "../../core/docsUrl.js";
import { resultReply, embedWithFilesReply, guildResultOptions } from "../../core/responses.js";
import { buildResultEmbed } from "../../core/embeds.js";
import { configManager } from "../../config/manager.js";
import { permissionsCommand } from "./commands/permissions.js";
import { pluginCommand } from "./commands/plugin.js";

function editorHint(): string {
  return `Edit this server in the [dashboard](${getEditorUrl()}) — load, change settings, and save without uploading YAML.`;
}

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
            .setDescription("Open the Dreamliner dashboard to edit this server's config"),
        ),
      execute: async ({ interaction, guildConfig, client, ephemeral }) => {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId!;
        const resultOptions = guildResultOptions(client, guildConfig);
        const editorComponents = [configEditorWithSupportRow()];

        if (sub === "editor") {
          await interaction.reply(
            resultReply(
              "Dashboard",
              [
                "Edit this server's config in the website dashboard — no YAML upload needed.",
                "",
                "**1.** Open the dashboard and sign in with Discord.",
                "**2.** Choose this server.",
                "**3.** Edit plugins and fields (channels/roles/members have search autocomplete).",
                "**4.** Click **Save** — Dreamliner applies the config immediately.",
                "",
                "You can still use `/config download` / `/config upload` if you prefer files.",
                "",
                `Dashboard: ${getEditorUrl()}`,
                `Docs: ${docsPageUrl("configuration")}`,
                `Site: ${getSiteUrl()}`,
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
                `Your current server configuration is attached.\n\n${editorHint()}`,
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
                  `Open the [dashboard](${getEditorUrl()}) to edit this server live, or customize this template and run \`/config upload\`.`,
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
              `${note}\n\nNeed more edits? ${editorHint()}`,
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
                `${result.errors.join("\n")}\n\nFix it in the [dashboard](${getEditorUrl()}), then try again.`,
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
                `${result.errors.join("\n")}\n\nFix errors in the [dashboard](${getEditorUrl()}), or correct the YAML and try \`/config upload\` again.`,
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
