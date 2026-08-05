import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type APIEmbed,
  type ButtonInteraction,
  type Client,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from "discord.js";
import type { EmojisConfig, GuildConfig } from "../../config/schemas/guild.js";
import { baseEmbed, setEmbedAuthor, trimLines } from "../../core/embeds.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { resultReply, guildResultOptions } from "../../core/responses.js";
import { TOGGLEABLE_PLUGINS, formatPluginLabel } from "./toggleablePlugins.js";

export const PLUGIN_LIST_PREFIX = "dl:plugin-list";

const PLUGINS_PER_PAGE = 12;

type PluginEntry = {
  value: string;
  enabled: boolean;
};

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages.length > 0 ? pages : [[]];
}

function allPluginEntries(guildConfig: GuildConfig): PluginEntry[] {
  return TOGGLEABLE_PLUGINS.map((value) => ({
    value,
    enabled: pluginEnabled(guildConfig, value),
  }));
}

function buildPluginListEmbed(
  pageEntries: PluginEntry[],
  page: number,
  pageCount: number,
  total: number,
  client: Client,
  emojis: EmojisConfig,
): APIEmbed {
  const lines = pageEntries.map(({ value, enabled }) => {
    const icon = enabled ? emojis.success : emojis.unchecked;
    return `${icon} **${formatPluginLabel(value)}** (\`${value}\`)`;
  });

  const description =
    lines.length > 0
      ? trimLines(lines.join("\n"))
      : "_No plugins are configured for this server._";

  return setEmbedAuthor(baseEmbed(), "Plugins", client, { tone: "neutral", emojis })
    .setDescription(description)
    .setFooter({
      text: `Page ${page + 1}/${pageCount} · ${total} plugin${total === 1 ? "" : "s"} · Use /plugin toggle to change status`,
    })
    .toJSON();
}

function buildNavRow(page: number, pageCount: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PLUGIN_LIST_PREFIX}:go:${Math.max(0, page - 1)}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${PLUGIN_LIST_PREFIX}:go:${Math.min(pageCount - 1, page + 1)}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );
}

function buildPluginListPayload(
  pageIndex: number,
  guildConfig: GuildConfig,
  client: Client,
): { embeds: APIEmbed[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const entries = allPluginEntries(guildConfig);
  const pages = chunk(entries, PLUGINS_PER_PAGE);
  const pageCount = pages.length;
  const page = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const pageEntries = pages[page] ?? [];

  const embed = buildPluginListEmbed(pageEntries, page, pageCount, entries.length, client, guildConfig.emojis);
  const components = pageCount > 1 ? [buildNavRow(page, pageCount)] : [];

  return { embeds: [embed], components };
}

export function buildPluginListMessage(
  pageIndex: number,
  guildConfig: GuildConfig,
  client: Client,
  ephemeral: boolean,
): InteractionReplyOptions {
  const { embeds, components } = buildPluginListPayload(pageIndex, guildConfig, client);
  return {
    embeds,
    components,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

function buildPluginListUpdate(
  pageIndex: number,
  guildConfig: GuildConfig,
  client: Client,
): InteractionUpdateOptions {
  const { embeds, components } = buildPluginListPayload(pageIndex, guildConfig, client);
  return { embeds, components };
}

function parsePluginListPage(customId: string): number | null {
  if (!customId.startsWith(`${PLUGIN_LIST_PREFIX}:go:`)) return null;
  const page = Number(customId.slice(`${PLUGIN_LIST_PREFIX}:go:`.length));
  return Number.isFinite(page) && page >= 0 ? page : null;
}

export async function handlePluginListButton(
  interaction: ButtonInteraction,
  guildConfig: GuildConfig,
): Promise<void> {
  const page = parsePluginListPage(interaction.customId);
  if (page === null) return;

  await interaction.update(buildPluginListUpdate(page, guildConfig, interaction.client));
}

export async function handlePluginListButtonInteraction(
  interaction: ButtonInteraction,
  getGuildConfig: (guildId: string) => Promise<GuildConfig>,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${PLUGIN_LIST_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guildId) return true;

  const member = interaction.member;
  if (!member || typeof member === "string" || !("permissions" in member)) return true;
  if (!(member as import("discord.js").GuildMember).permissions.has(PermissionFlagsBits.ManageGuild)) {
    const guildConfig = await getGuildConfig(interaction.guildId);
    await interaction.reply(
      resultReply(
        "Permission denied",
        "You need **Manage Server** to browse plugin status.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  try {
    const guildConfig = await getGuildConfig(interaction.guildId);
    await handlePluginListButton(interaction, guildConfig);
  } catch (error) {
    console.error("Plugin list interaction error:", error);
    if (!interaction.replied && !interaction.deferred) {
      const guildConfig = await getGuildConfig(interaction.guildId);
      await interaction
        .reply(
          resultReply(
            "Error",
            "Could not update the plugin list.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
  }

  return true;
}
