import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type APIEmbed,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { baseEmbed, codeBlock, setEmbedAuthor, trimLines } from "../../../core/embeds.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import type { Client } from "discord.js";

export const HELP_BUTTON_PREFIX = "dl:help";

const COMMANDS_PER_PAGE = 14;
const MAX_SELECT_OPTIONS = 25;

const PLUGIN_CATEGORIES: { id: string; label: string; plugins: string[] }[] = [
  { id: "core", label: "Core", plugins: ["utility", "infractions"] },
  { id: "moderation", label: "Moderation", plugins: ["automod", "censor", "admin", "persist", "slowmode"] },
  {
    id: "roles",
    label: "Roles",
    plugins: ["roles", "reaction_roles", "role_buttons", "self_grantable_roles", "pingable_roles", "role_manager"],
  },
  {
    id: "automation",
    label: "Automation",
    plugins: ["welcome_message", "tags", "post", "autodelete", "autoreactions", "reminders", "counters", "companion_channels"],
  },
  {
    id: "tracking",
    label: "Tracking & Misc",
    plugins: ["name_history", "locate_user", "stats", "custom_events", "command_aliases"],
  },
];

const PLUGIN_LABELS: Record<string, string> = {
  utility: "Utility",
  infractions: "Infractions",
  automod: "Automod",
  censor: "Censor",
  admin: "Admin",
  persist: "Persist",
  slowmode: "Slowmode",
  roles: "Roles",
  reaction_roles: "Reaction Roles",
  role_buttons: "Role Buttons",
  self_grantable_roles: "Self Roles",
  pingable_roles: "Pingable Roles",
  role_manager: "Role Manager",
  welcome_message: "Welcome",
  tags: "Tags",
  post: "Scheduled Posts",
  autodelete: "Autodelete",
  autoreactions: "Autoreactions",
  reminders: "Reminders",
  counters: "Counters",
  companion_channels: "Companion Channels",
  name_history: "Name History",
  locate_user: "Locate User",
  stats: "Stats",
  custom_events: "Custom Events",
  command_aliases: "Command Aliases",
};

const PLUGIN_ORDER = [
  "utility",
  "infractions",
  "automod",
  "censor",
  "admin",
  "persist",
  "slowmode",
  "roles",
  "reaction_roles",
  "role_buttons",
  "self_grantable_roles",
  "pingable_roles",
  "role_manager",
  "welcome_message",
  "tags",
  "post",
  "autodelete",
  "autoreactions",
  "reminders",
  "counters",
  "companion_channels",
  "name_history",
  "locate_user",
  "stats",
  "custom_events",
  "command_aliases",
];

const PLUGIN_DOCS: Record<string, string> = {
  utility: "plugins/utility.md",
  infractions: "plugins/infraction.md",
  automod: "plugins/automod.md",
  censor: "plugins/censor.md",
  admin: "plugins/admin.md",
  persist: "plugins/persist.md",
  slowmode: "plugins/slowmode.md",
  roles: "plugins/roles.md",
  reaction_roles: "plugins/reaction_roles.md",
  role_buttons: "plugins/role_buttons.md",
  self_grantable_roles: "plugins/self_grantable_roles.md",
  pingable_roles: "plugins/pingable_roles.md",
  role_manager: "plugins/role_manager.md",
  welcome_message: "plugins/welcome_message.md",
  tags: "plugins/tags.md",
  post: "plugins/post.md",
  autodelete: "plugins/autodelete.md",
  autoreactions: "plugins/autoreactions.md",
  reminders: "plugins/reminders.md",
  counters: "plugins/counters.md",
  companion_channels: "plugins/companion_channels.md",
  name_history: "plugins/name_history.md",
  locate_user: "plugins/locate_user.md",
  stats: "plugins/stats.md",
  custom_events: "plugins/custom_events.md",
  command_aliases: "plugins/command_aliases.md",
};

export type HelpPage = {
  plugin: string;
  title: string;
  pageInPlugin: number;
  totalInPlugin: number;
  embed: APIEmbed;
};

export type HelpState = {
  pages: HelpPage[];
  plugins: string[];
  pluginFirstPage: Map<string, number>;
  overviewPageIndex: number | null;
};

type CommandLine = {
  name: string;
  description: string;
  plugin: string;
};

type HelpAction = { action: "prev" | "next" | "select"; pageIndex: number; plugin?: string; query: string };

function encodeQuery(query: string): string {
  if (!query) return "";
  return Buffer.from(query, "utf-8").toString("base64url");
}

function decodeQuery(encoded: string | undefined): string {
  if (!encoded) return "";
  try {
    return Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    return "";
  }
}

function querySuffix(query: string): string {
  const q = encodeQuery(query);
  return q ? `:${q}` : "";
}

function flattenCommand(cmd: SlashCommandDefinition): CommandLine[] {
  const json = cmd.data.toJSON() as {
    name: string;
    description: string;
    options?: Array<{
      type: number;
      name: string;
      description?: string;
      options?: Array<{ type: number; name: string; description?: string }>;
    }>;
  };

  const lines: CommandLine[] = [];

  for (const opt of json.options ?? []) {
    if (opt.type === 1) {
      lines.push({
        name: `/${json.name} ${opt.name}`,
        description: opt.description ?? "",
        plugin: cmd.plugin,
      });
    } else if (opt.type === 2) {
      for (const sub of opt.options ?? []) {
        if (sub.type === 1) {
          lines.push({
            name: `/${json.name} ${opt.name} ${sub.name}`,
            description: sub.description ?? "",
            plugin: cmd.plugin,
          });
        }
      }
    }
  }

  if (lines.length === 0) {
    lines.push({ name: `/${json.name}`, description: json.description, plugin: cmd.plugin });
  }

  return lines;
}

function filterLines(lines: CommandLine[], query: string): CommandLine[] {
  if (!query) return lines;
  const q = query.toLowerCase();
  return lines.filter((l) => l.name.toLowerCase().includes(q) || l.description.toLowerCase().includes(q));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [[]];
}

export function buildHelpState(
  commands: SlashCommandDefinition[],
  query: string,
  client: Client,
  emojis?: EmojisConfig,
): HelpState {
  const allLines = filterLines(
    commands.filter((c) => c.plugin !== "config").flatMap(flattenCommand),
    query.trim().toLowerCase(),
  );

  const plugins = PLUGIN_ORDER.filter((p) => allLines.some((l) => l.plugin === p));
  const pages: HelpPage[] = [];
  const pluginFirstPage = new Map<string, number>();
  let overviewPageIndex: number | null = null;

  if (!query && allLines.length > 0) {
    const counts = plugins.map((p) => {
      const count = allLines.filter((l) => l.plugin === p).length;
      return `**${PLUGIN_LABELS[p] ?? p}** - ${count} command${count === 1 ? "" : "s"}`;
    });

    overviewPageIndex = pages.length;
    pages.push({
      plugin: "overview",
      title: "Dreamliner Help",
      pageInPlugin: 1,
      totalInPlugin: 1,
      embed: setEmbedAuthor(baseEmbed(), "Dreamliner Help", client, { tone: "neutral", emojis })
        .setDescription(
          trimLines(`
            Browse commands by category using the menu below.

            ${counts.join("\n")}
          `),
        )
        .setFooter({ text: "Overview" })
        .toJSON(),
    });
  }

  for (const plugin of plugins) {
    const pluginLines = allLines.filter((l) => l.plugin === plugin);
    const chunks = chunk(pluginLines, COMMANDS_PER_PAGE);
    const label = PLUGIN_LABELS[plugin] ?? plugin;

    if (pluginLines.length === 0) {
      continue;
    }

    pluginFirstPage.set(plugin, pages.length);

    chunks.forEach((group, index) => {
      const entries =
        group.length > 0
          ? group.map((l) => `${l.name} - ${l.description}`).join("\n")
          : "No commands found.";

      const title = query ? `Help: ${query}` : `${label} commands`;

      pages.push({
        plugin,
        title,
        pageInPlugin: index + 1,
        totalInPlugin: chunks.length,
        embed: setEmbedAuthor(baseEmbed(), title, client, { tone: "neutral", emojis })
          .setDescription(codeBlock(entries))
          .setFooter({
            text: query
              ? `Search results · ${label} · Page ${index + 1}/${chunks.length}`
              : `${label} · Page ${index + 1}/${chunks.length}`,
          })
          .toJSON(),
      });
    });
  }

  if (pages.length === 0) {
    overviewPageIndex = 0;
    pages.push({
      plugin: "overview",
      title: "Dreamliner Help",
      pageInPlugin: 1,
      totalInPlugin: 1,
      embed: setEmbedAuthor(baseEmbed(), "Dreamliner Help", client, { tone: "neutral", emojis })
        .setDescription(query ? `No commands matched **${query}**.` : "No commands available.")
        .toJSON(),
    });
  }

  return { pages, plugins, pluginFirstPage, overviewPageIndex };
}

function buildPaginationRow(pageIndex: number, state: HelpState, query: string): ActionRowBuilder<ButtonBuilder> {
  const { pages } = state;
  const suffix = querySuffix(query);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${HELP_BUTTON_PREFIX}:prev:${pageIndex}${suffix}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex <= 0),
    new ButtonBuilder()
      .setCustomId(`${HELP_BUTTON_PREFIX}:next:${pageIndex}${suffix}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex >= pages.length - 1),
  );
}

function buildPluginSelectRows(
  pageIndex: number,
  state: HelpState,
  query: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const { plugins, overviewPageIndex } = state;
  const current = state.pages[pageIndex] ?? state.pages[0];
  const suffix = querySuffix(query);

  const options: { label: string; value: string; default?: boolean }[] = [];

  if (overviewPageIndex !== null && !query) {
    options.push({
      label: "Overview",
      value: "overview",
      default: current.plugin === "overview",
    });

    for (const category of PLUGIN_CATEGORIES) {
      const active = category.plugins.some((p) => plugins.includes(p));
      if (!active) continue;
      options.push({
        label: category.label,
        value: `cat:${category.id}`,
        default: category.plugins.includes(current.plugin),
      });
    }
  } else {
    for (const plugin of plugins) {
      options.push({
        label: PLUGIN_LABELS[plugin] ?? plugin,
        value: plugin,
        default: current.plugin === plugin,
      });
    }
  }

  if (options.length === 0) return [];

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  const batches = chunk(options, MAX_SELECT_OPTIONS);

  batches.forEach((batch, batchIndex) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${HELP_BUTTON_PREFIX}:select:${pageIndex}:${batchIndex}${suffix}`)
      .setPlaceholder(
        batches.length > 1 ? `Jump to plugin (${batchIndex + 1}/${batches.length})…` : "Jump to plugin…",
      )
      .addOptions(batch);

    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
  });

  return rows;
}

function buildHelpComponents(pageIndex: number, state: HelpState, query: string) {
  return [buildPaginationRow(pageIndex, state, query), ...buildPluginSelectRows(pageIndex, state, query)];
}

export function buildHelpMessage(
  pageIndex: number,
  query: string,
  docsBaseUrl: string,
  ephemeral: boolean,
  client: Client,
  emojis?: EmojisConfig,
  commands = getAllSlashCommands(),
): InteractionReplyOptions {
  const state = buildHelpState(commands, query, client, emojis);
  const safeIndex = Math.max(0, Math.min(pageIndex, state.pages.length - 1));
  const page = state.pages[safeIndex]!;

  const docsPath = page.plugin !== "overview" ? PLUGIN_DOCS[page.plugin] : "index.md";
  const embed = { ...page.embed };
  if (embed.description && docsPath) {
    embed.description = `${embed.description}\n[Documentation](${docsBaseUrl}/${docsPath})`;
  }

  return {
    embeds: [embed],
    components: buildHelpComponents(safeIndex, state, query),
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}

export function buildHelpUpdate(
  pageIndex: number,
  query: string,
  docsBaseUrl: string,
  client: Client,
  emojis?: EmojisConfig,
  commands = getAllSlashCommands(),
): InteractionUpdateOptions {
  const { embeds, components } = buildHelpMessage(pageIndex, query, docsBaseUrl, false, client, emojis, commands);
  return { embeds, components };
}

export function parseHelpButton(customId: string): HelpAction | null {
  if (!customId.startsWith(`${HELP_BUTTON_PREFIX}:`)) return null;

  const parts = customId.slice(HELP_BUTTON_PREFIX.length + 1).split(":");
  const action = parts[0];
  if (action !== "prev" && action !== "next") return null;

  const pageIndex = Number(parts[1]);
  const query = decodeQuery(parts[2]);
  if (Number.isNaN(pageIndex)) return null;
  return { action, pageIndex, query };
}

export function parseHelpSelect(customId: string, value: string): HelpAction | null {
  if (!customId.startsWith(`${HELP_BUTTON_PREFIX}:select:`)) return null;

  const rest = customId.slice(`${HELP_BUTTON_PREFIX}:select:`.length);
  const parts = rest.split(":");
  const pageIndex = Number(parts[0]);
  if (Number.isNaN(pageIndex) || !value) return null;

  const query = decodeQuery(parts.slice(2).join(":") || undefined);

  return { action: "select", pageIndex, plugin: value, query };
}

export function resolveHelpPageIndex(state: HelpState, parsed: HelpAction): number {
  const { pages } = state;
  if (parsed.action === "prev") return Math.max(0, parsed.pageIndex - 1);
  if (parsed.action === "next") return Math.min(pages.length - 1, parsed.pageIndex + 1);
  if (parsed.action === "select" && parsed.plugin) {
    if (parsed.plugin === "overview" && state.overviewPageIndex !== null) {
      return state.overviewPageIndex;
    }
    if (parsed.plugin.startsWith("cat:")) {
      const category = PLUGIN_CATEGORIES.find((c) => c.id === parsed.plugin!.slice(4));
      if (category) {
        for (const plugin of category.plugins) {
          const idx = state.pluginFirstPage.get(plugin);
          if (idx !== undefined) return idx;
        }
      }
    }
    const idx = state.pluginFirstPage.get(parsed.plugin);
    if (idx !== undefined) return idx;
  }
  return Math.max(0, Math.min(parsed.pageIndex, pages.length - 1));
}

async function applyHelpUpdate(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: HelpAction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
) {
  const state = buildHelpState(getAllSlashCommands(), parsed.query, interaction.client, emojis);
  const pageIndex = resolveHelpPageIndex(state, parsed);
  await interaction.update(buildHelpUpdate(pageIndex, parsed.query, docsBaseUrl, interaction.client, emojis));
}

export async function handleHelpButton(
  interaction: ButtonInteraction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
): Promise<void> {
  const parsed = parseHelpButton(interaction.customId);
  if (!parsed) return;
  await applyHelpUpdate(interaction, parsed, docsBaseUrl, emojis);
}

export async function handleHelpSelect(
  interaction: StringSelectMenuInteraction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
): Promise<void> {
  const value = interaction.values[0];
  if (!value) return;
  const parsed = parseHelpSelect(interaction.customId, value);
  if (!parsed) return;
  await applyHelpUpdate(interaction, parsed, docsBaseUrl, emojis);
}
