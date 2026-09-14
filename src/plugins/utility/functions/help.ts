import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { EmojisConfig } from "../../../config/schemas/guild.js";
import { SUPPORT_URL, getSiteUrl, linkButton } from "../../../core/docsUrl.js";
import { HELP_CATEGORIES, type HelpCategory } from "../../../core/helpCategories.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { baseEmbed, setEmbedAuthor, trimLines, type ResultContainer } from "../../../core/embeds.js";
import { containerEdit, containerReply } from "../../../core/responses.js";
import { getAllSlashCommands } from "../../availablePlugins.js";
import { translatorFor, type Translator } from "../../../i18n/index.js";

/** Translated category label — falls back to the English label from helpCategories.ts. */
function categoryLabel(t: Translator, category: HelpCategory): string {
  return t(`help.category.${category.id}.label`, category.label);
}

/** Translated category blurb — falls back to the English blurb from helpCategories.ts. */
function categoryBlurb(t: Translator, category: HelpCategory): string {
  return t(`help.category.${category.id}.blurb`, category.blurb);
}

/** Translated plugin group heading used inside a category's command list. */
function groupLabel(t: Translator, plugin: string): string {
  return t(`help.group.${plugin}`, GROUP_LABELS[plugin] ?? plugin);
}

export const HELP_BUTTON_PREFIX = "dl:help";

const MAX_SELECT_OPTIONS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;
const COMMANDS_PER_CATEGORY_PAGE = 12;

type OptionLine = {
  name: string;
  description: string;
  required: boolean;
};

type CommandEntry = {
  key: string;
  usage: string;
  description: string;
  plugin: string;
  rootName: string;
  options: OptionLine[];
};

type HelpView =
  | { kind: "home" }
  | { kind: "category"; categoryId: string; page: number }
  | { kind: "detail"; categoryId: string; page: number; commandKey: string }
  | { kind: "search"; page: number };

type ParsedHelpAction =
  | { type: "button"; view: HelpView; query: string }
  | { type: "select"; value: string; view: HelpView; query: string };

const CATEGORIES: HelpCategory[] = HELP_CATEGORIES;

const PLUGIN_DOCS: Record<string, string> = {
  utility: "plugins/utility",
  infractions: "plugins/infraction",
  automod: "plugins/automod",
  scam_protect: "plugins/scam_protect",
  persist: "plugins/persist",
  slowmode: "plugins/slowmode",
  roles: "plugins/roles",
  reaction_roles: "plugins/reaction_roles",
  role_buttons: "plugins/role_buttons",
  welcome_message: "plugins/welcome_message",
  tags: "plugins/tags",
  autodelete: "plugins/autodelete",
  autoreactions: "plugins/autoreactions",
  autoreplies: "plugins/autoreplies",
  autothreads: "plugins/autothreads",
  reminders: "plugins/reminders",
  counters: "plugins/counters",
  companion_channels: "plugins/companion_channels",
  name_history: "plugins/name_history",
  locate_user: "plugins/locate_user",
  stats: "plugins/stats",
  dream_commands: "plugins/dream_commands",
  translation: "plugins/translation",
  bot_customisation: "plugins/bot_customisation",
  reviews: "plugins/reviews",
  suggestions: "plugins/suggestions",
  passport: "plugins/passport",
  economy: "plugins/economy",
  config: "configuration",
  starboard: "plugins/starboard",
  autorole: "plugins/autorole",
  username_saver: "plugins/username_saver",
  member_identity: "plugins/member_identity",
};

function decodeQuery(encoded: string | undefined): string {
  if (!encoded || encoded === "_") return "";
  try {
    return Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    return "";
  }
}

function encodeQuerySafe(query: string): string {
  if (!query) return "_";
  return Buffer.from(query, "utf-8").toString("base64url");
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function formatOptionToken(name: string, required: boolean): string {
  return required ? `<${name}>` : `[${name}]`;
}

function flattenCommand(cmd: SlashCommandDefinition): CommandEntry[] {
  const json = cmd.data.toJSON() as {
    name: string;
    description: string;
    options?: Array<{
      type: number;
      name: string;
      description?: string;
      required?: boolean;
      options?: Array<{
        type: number;
        name: string;
        description?: string;
        required?: boolean;
        options?: Array<{ type: number; name: string; description?: string; required?: boolean }>;
      }>;
    }>;
  };

  const leafOptions = (
    options: Array<{ type: number; name: string; description?: string; required?: boolean }> | undefined,
  ): OptionLine[] =>
    (options ?? [])
      .filter((o) => o.type !== 1 && o.type !== 2)
      .map((o) => ({
        name: o.name,
        description: o.description ?? "",
        required: Boolean(o.required),
      }));

  const entries: CommandEntry[] = [];

  for (const opt of json.options ?? []) {
    if (opt.type === 1) {
      const options = leafOptions(opt.options);
      const usage = [`/${json.name}`, opt.name, ...options.map((o) => formatOptionToken(o.name, o.required))].join(" ");
      entries.push({
        key: `${cmd.plugin}:${json.name}:${opt.name}`,
        usage,
        description: opt.description ?? "",
        plugin: cmd.plugin,
        rootName: json.name,
        options,
      });
    } else if (opt.type === 2) {
      for (const sub of opt.options ?? []) {
        if (sub.type !== 1) continue;
        const options = leafOptions(sub.options);
        const usage = [
          `/${json.name}`,
          opt.name,
          sub.name,
          ...options.map((o) => formatOptionToken(o.name, o.required)),
        ].join(" ");
        entries.push({
          key: `${cmd.plugin}:${json.name}:${opt.name}:${sub.name}`,
          usage,
          description: sub.description ?? "",
          plugin: cmd.plugin,
          rootName: json.name,
          options,
        });
      }
    }
  }

  if (entries.length === 0) {
    const options = leafOptions(json.options);
    const usage = [`/${json.name}`, ...options.map((o) => formatOptionToken(o.name, o.required))].join(" ");
    entries.push({
      key: `${cmd.plugin}:${json.name}`,
      usage,
      description: json.description,
      plugin: cmd.plugin,
      rootName: json.name,
      options,
    });
  }

  return entries;
}

function allEntries(commands = getAllSlashCommands()): CommandEntry[] {
  return commands.flatMap(flattenCommand).sort((a, b) => a.usage.localeCompare(b.usage));
}

function categoryEntries(category: HelpCategory, entries: CommandEntry[]): CommandEntry[] {
  return entries.filter((entry) =>
    category.include.some((rule) => {
      if (rule.plugin !== entry.plugin) return false;
      if (!rule.roots) return true;
      return rule.roots.includes(entry.rootName);
    }),
  );
}

function filterEntries(entries: CommandEntry[], query: string): CommandEntry[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter(
    (e) =>
      e.usage.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.rootName.toLowerCase().includes(q) ||
      e.plugin.toLowerCase().includes(q),
  );
}

function findCategory(id: string): HelpCategory | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

function serializeView(view: HelpView): string {
  switch (view.kind) {
    case "home":
      return "h";
    case "category":
      return `c:${view.categoryId}:${view.page}`;
    case "detail":
      return `d:${view.categoryId}:${view.page}:${Buffer.from(view.commandKey, "utf-8").toString("base64url")}`;
    case "search":
      return `s:${view.page}`;
  }
}

function parseView(raw: string | undefined): HelpView {
  if (!raw || raw === "h") return { kind: "home" };

  const parts = raw.split(":");
  const kind = parts[0];

  if (kind === "c" && parts[1]) {
    return { kind: "category", categoryId: parts[1], page: Math.max(0, Number(parts[2] ?? 0) || 0) };
  }

  if (kind === "d" && parts[1] && parts[3]) {
    let commandKey = parts.slice(3).join(":");
    try {
      commandKey = Buffer.from(commandKey, "base64url").toString("utf-8");
    } catch {
      /* keep raw */
    }
    return {
      kind: "detail",
      categoryId: parts[1],
      page: Math.max(0, Number(parts[2] ?? 0) || 0),
      commandKey,
    };
  }

  if (kind === "s") {
    return { kind: "search", page: Math.max(0, Number(parts[1] ?? 0) || 0) };
  }

  return { kind: "home" };
}

function buildCustomId(action: string, view: HelpView, query: string): string {
  const id = `${HELP_BUTTON_PREFIX}:${action}:${serializeView(view)}:${encodeQuerySafe(query)}`;
  if (id.length <= 100) return id;
  // Drop query if oversized; search state still rebuilds from empty home path rarely.
  return `${HELP_BUTTON_PREFIX}:${action}:${serializeView(view)}:_`.slice(0, 100);
}

function parseCustomId(customId: string): { action: string; view: HelpView; query: string } | null {
  if (!customId.startsWith(`${HELP_BUTTON_PREFIX}:`)) return null;
  const rest = customId.slice(HELP_BUTTON_PREFIX.length + 1);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;
  const action = rest.slice(0, firstColon);
  const afterAction = rest.slice(firstColon + 1);

  // View serializers use colons; query is always the final segment.
  const lastColon = afterAction.lastIndexOf(":");
  if (lastColon < 0) return { action, view: parseView(afterAction), query: "" };

  const viewRaw = afterAction.slice(0, lastColon);
  const queryRaw = afterAction.slice(lastColon + 1);
  return { action, view: parseView(viewRaw), query: decodeQuery(queryRaw) };
}

function commandLine(entry: CommandEntry): string {
  return `\`${entry.usage.split(" <")[0]!.split(" [")[0]}\` - ${entry.description}`;
}

function shortCommandName(entry: CommandEntry): string {
  return entry.usage.split(" <")[0]!.split(" [")[0]!;
}

function splitFieldValue(lines: string[], t: Translator): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > MAX_FIELD_VALUE) {
      if (current) chunks.push(current);
      current = line.length > MAX_FIELD_VALUE ? `${line.slice(0, MAX_FIELD_VALUE - 1)}…` : line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [t("help.noCommands", "No commands.")];
}

function docsPathFor(entries: CommandEntry[], fallback = ""): string {
  const plugin = entries[0]?.plugin;
  return (plugin && PLUGIN_DOCS[plugin]) || fallback;
}

function buildHomeEmbed(entries: CommandEntry[], client: Client, t: Translator, emojis?: EmojisConfig): ResultContainer {
  const categoryNames = CATEGORIES.filter(
    (category) => category.id === "config" || categoryEntries(category, entries).length > 0,
  )
    .map((category) => categoryLabel(t, category))
    .join(" · ");

  return setEmbedAuthor(baseEmbed(), t("help.title", "Help"), client, {
    tone: "neutral",
    emojis,
    emoji: "<:icons_book:1544418012700999820>",
  })
    .setDescription(
      trimLines(`
        ${t("help.home.intro", "Choose a **category** from the menu below to browse commands, or search with `/help query:ban`.")}

        ${categoryNames}
      `),
    )
    .setFooter({ text: t("help.home.footer", "{count} commands", { count: entries.length }) });
}

const GROUP_LABELS: Record<string, string> = {
  infractions: "Infractions",
  automod: "Automod",
  scam_protect: "Scam Protect",
  slowmode: "Slowmode",
  persist: "Sticky messages",
  utility: "Utility",
  roles: "Role assign",
  reaction_roles: "Reaction roles",
  role_buttons: "Role buttons",
  autorole: "Autorole",
  member_identity: "Member identity",
  locate_user: "Locate",
  name_history: "Name history",
  welcome_message: "Welcome",
  tags: "Tags",
  autodelete: "Autodelete",
  autoreactions: "Autoreactions",
  autoreplies: "Autoreplies",
  autothreads: "Autothreads",
  translation: "Translation",
  reminders: "Reminders",
  counters: "Counters",
  companion_channels: "Companion channels",
  dream_commands: "Commands",
  stats: "Stats",
  bot_customisation: "Bot customisation",
  reviews: "Reviews",
  suggestions: "Suggestions",
  config: "Config",
};

function buildCategoryEmbed(
  category: HelpCategory,
  pageEntries: CommandEntry[],
  page: number,
  totalPages: number,
  totalCommands: number,
  client: Client,
  t: Translator,
  emojis?: EmojisConfig,
): ResultContainer {
  const groups = new Map<string, CommandEntry[]>();
  for (const entry of pageEntries) {
    const label = groupLabel(t, entry.plugin);
    const list = groups.get(label) ?? [];
    list.push(entry);
    groups.set(label, list);
  }

  const blurb = categoryBlurb(t, category);
  const sections = [...groups.entries()].map(([label, groupEntries]) => {
    const body = groupEntries.map(commandLine).join("\n");
    return `**${label}**\n${body}`;
  });

  const description = trimLines(`
    ${blurb}

    ${sections.join("\n\n")}
  `);

  const embed = setEmbedAuthor(baseEmbed(), categoryLabel(t, category), client, { tone: "neutral", emojis }).setFooter({
    text: t(
      "help.category.footer",
      "Page {page}/{totalPages} · {count} commands · Select a command for details",
      { page: page + 1, totalPages, count: totalCommands },
    ),
  });

  if (description.length <= MAX_DESCRIPTION) {
    embed.setDescription(description);
  } else {
    embed.setDescription(blurb);
    let fieldCount = 0;
    for (const [label, groupEntries] of groups) {
      const parts = splitFieldValue(groupEntries.map(commandLine), t);
      parts.slice(0, 25 - fieldCount).forEach((value, index) => {
        embed.addFields({ name: index === 0 ? label : `${label} (${index + 1})`, value });
        fieldCount += 1;
      });
    }
  }

  return embed;
}

function buildDetailEmbed(entry: CommandEntry, categoryLabelText: string, client: Client, t: Translator, emojis?: EmojisConfig): ResultContainer {
  const optionLines =
    entry.options.length > 0
      ? entry.options
          .map((o) => `• **${formatOptionToken(o.name, o.required)}** - ${o.description || t("help.noDescription", "No description")}`)
          .join("\n")
      : t("help.noOptions", "_This command has no options._");

  return setEmbedAuthor(baseEmbed(), shortCommandName(entry), client, { tone: "neutral", emojis })
    .setDescription(
      trimLines(`
        ${entry.description}

        **${t("help.usage", "Usage")}**
        \`${entry.usage}\`

        **${t("help.options", "Options")}**
        ${optionLines}
      `),
    )
    .setFooter({
      text: t("help.detail.footer", "{category} · Use the menus below to keep browsing", { category: categoryLabelText }),
    });
}

function buildSearchEmbed(
  pageEntries: CommandEntry[],
  query: string,
  page: number,
  totalPages: number,
  total: number,
  client: Client,
  t: Translator,
  emojis?: EmojisConfig,
): ResultContainer {
  if (total === 0) {
    return setEmbedAuthor(baseEmbed(), t("help.search.title", "Help search"), client, { tone: "warning", emojis }).setDescription(
      t(
        "help.search.empty",
        "No commands matched **{query}**.\n\nTry a shorter term, or open Help without a query to browse categories.",
        { query },
      ),
    );
  }

  const lines = pageEntries.map(commandLine);
  return setEmbedAuthor(baseEmbed(), t("help.search.titleWithQuery", "Search: {query}", { query }), client, {
    tone: "neutral",
    emojis,
    emoji: "<:icons_search:1544417406640726168>",
  })
    .setDescription(trimLines(`${lines.join("\n")}`))
    .setFooter({
      text: t(
        "help.search.footer",
        "{count} match(es) · Page {page}/{totalPages}",
        { count: total, page: page + 1, totalPages },
      ),
    });
}

function buildNavButtons(view: HelpView, query: string, pageCount: number, t: Translator): ActionRowBuilder<ButtonBuilder> {
  const homeView: HelpView = { kind: "home" };
  let page = 0;

  if (view.kind === "detail" || view.kind === "category" || view.kind === "search") {
    page = view.page;
  }

  const backView: HelpView | null =
    view.kind === "detail"
      ? query
        ? { kind: "search", page: view.page }
        : { kind: "category", categoryId: view.categoryId, page: view.page }
      : null;

  const prevView: HelpView | null =
    view.kind === "category" && page > 0
      ? { kind: "category", categoryId: view.categoryId, page: page - 1 }
      : view.kind === "search" && page > 0
        ? { kind: "search", page: page - 1 }
        : null;

  const nextView: HelpView | null =
    view.kind === "category" && page < pageCount - 1
      ? { kind: "category", categoryId: view.categoryId, page: page + 1 }
      : view.kind === "search" && page < pageCount - 1
        ? { kind: "search", page: page + 1 }
        : null;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId("go", homeView, ""))
      .setLabel(t("help.button.home", "Home"))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(view.kind === "home" && !query),
  );

  if (backView) {
    row.addComponents(
      new ButtonBuilder().setCustomId(buildCustomId("go", backView, query)).setLabel(t("help.button.back", "Back")).setStyle(ButtonStyle.Secondary),
    );
  }

  if (view.kind === "category" || view.kind === "search") {
    // Distinct action names so disabled prev/next never share a custom_id when both
    // fall back to the current view (single-page categories).
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId("prev", prevView ?? view, query))
        .setLabel(t("help.button.previous", "Previous"))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!prevView),
      new ButtonBuilder()
        .setCustomId(buildCustomId("next", nextView ?? view, query))
        .setLabel(t("help.button.next", "Next"))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!nextView),
    );
  }

  return row;
}

function buildHelpLinkRow(docsUrl: string, docsPath: string, t: Translator): ActionRowBuilder<ButtonBuilder> {
  const docsTarget =
    !docsPath || docsPath === "index" ? docsUrl.replace(/\/$/, "") : `${docsUrl.replace(/\/$/, "")}/${docsPath.replace(/^\//, "")}`;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    linkButton(t("help.button.website", "Website"), getSiteUrl()),
    linkButton(t("help.button.docs", "Docs"), docsTarget),
    linkButton(t("help.button.support", "Support"), SUPPORT_URL),
  );
}

function buildCategorySelect(view: HelpView, query: string, entries: CommandEntry[], t: Translator): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const current =
    view.kind === "category" || view.kind === "detail" ? view.categoryId : view.kind === "home" ? "home" : "";

  const options = [
    {
      label: t("help.button.home", "Home"),
      description: t("help.select.startHere", "Start here"),
      value: "home",
      default: view.kind === "home",
    },
    ...CATEGORIES.filter(
      (category) => category.id === "config" || categoryEntries(category, entries).length > 0,
    ).map((category) => ({
      label: categoryLabel(t, category),
      description: categoryBlurb(t, category).slice(0, 100),
      value: `cat:${category.id}`,
      default: current === category.id,
    })),
  ];

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("pick", view, query))
      .setPlaceholder(t("help.select.browseCategories", "Browse categories…"))
      .addOptions(options.slice(0, MAX_SELECT_OPTIONS)),
  );
}

function buildCommandSelect(
  view: HelpView,
  query: string,
  pageEntries: CommandEntry[],
  t: Translator,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  if (pageEntries.length === 0) return null;
  if (view.kind !== "category" && view.kind !== "search" && view.kind !== "detail") return null;

  const selectedKey = view.kind === "detail" ? view.commandKey : null;

  const options = pageEntries.slice(0, MAX_SELECT_OPTIONS).map((entry, index) => ({
    label: shortCommandName(entry).slice(0, 100),
    description: entry.description.slice(0, 100) || t("help.noDescription", "No description"),
    value: `cmd:${index}`,
    default: entry.key === selectedKey,
  }));

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId("cmd", view.kind === "detail" ? { kind: "category", categoryId: view.categoryId, page: view.page } : view, query))
      .setPlaceholder(t("help.select.viewCommandDetails", "View command details…"))
      .addOptions(options),
  );
}

function findCategoryForEntry(entry: CommandEntry): HelpCategory | undefined {
  return CATEGORIES.find((category) => categoryEntries(category, [entry]).length > 0);
}

function resolvePageEntries(view: HelpView, entries: CommandEntry[], query: string): {
  embedEntries: CommandEntry[];
  pageEntries: CommandEntry[];
  page: number;
  pageCount: number;
  category?: HelpCategory;
  detail?: CommandEntry;
  docsPath: string;
} {
  if (view.kind === "detail") {
    const detail = entries.find((e) => e.key === view.commandKey);
    const category = findCategory(view.categoryId) ?? (detail ? findCategoryForEntry(detail) : undefined);
    const pool = query ? filterEntries(entries, query) : category ? categoryEntries(category, entries) : entries;
    const pages = chunk(pool, COMMANDS_PER_CATEGORY_PAGE);
    const page = Math.min(view.page, Math.max(0, pages.length - 1));
    return {
      embedEntries: pool,
      pageEntries: pages[page] ?? [],
      page,
      pageCount: pages.length,
      category,
      detail,
      docsPath: docsPathFor(detail ? [detail] : pages[page] ?? []),
    };
  }

  if (query || view.kind === "search") {
    const matched = query ? filterEntries(entries, query) : entries;
    const pages = chunk(matched, COMMANDS_PER_CATEGORY_PAGE);
    const page = view.kind === "search" ? Math.min(view.page, Math.max(0, pages.length - 1)) : 0;
    return {
      embedEntries: matched,
      pageEntries: pages[page] ?? [],
      page,
      pageCount: pages.length,
      docsPath: "",
    };
  }

  if (view.kind === "home") {
    return { embedEntries: entries, pageEntries: [], page: 0, pageCount: 1, docsPath: "" };
  }

  const category = findCategory(view.categoryId) ?? CATEGORIES[0]!;
  const inCategory = categoryEntries(category, entries);
  const pages = chunk(inCategory, COMMANDS_PER_CATEGORY_PAGE);
  const page = Math.min(view.page, Math.max(0, pages.length - 1));
  const pageEntries = pages[page] ?? [];

  return {
    embedEntries: inCategory,
    pageEntries,
    page,
    pageCount: pages.length,
    category,
    docsPath: docsPathFor(pageEntries, PLUGIN_DOCS[category.include[0]?.plugin ?? ""] ?? ""),
  };
}

function resolveViewFromSelect(value: string, current: HelpView, pageEntries: CommandEntry[]): HelpView {
  if (value === "home") return { kind: "home" };

  if (value.startsWith("cat:")) {
    const categoryId = value.slice(4);
    return { kind: "category", categoryId, page: 0 };
  }

  if (value.startsWith("cmd:")) {
    const index = Number(value.slice(4));
    const entry = pageEntries[index];
    if (!entry) return current;

    const owning = findCategoryForEntry(entry);
    const categoryId =
      current.kind === "category" || current.kind === "detail"
        ? current.categoryId
        : (owning?.id ?? "tools");
    const page = current.kind === "category" || current.kind === "detail" || current.kind === "search" ? current.page : 0;
    return { kind: "detail", categoryId, page, commandKey: entry.key };
  }

  return current;
}

function buildHelpPayload(
  view: HelpView,
  query: string,
  docsBaseUrl: string,
  client: Client,
  t: Translator,
  emojis?: EmojisConfig,
  commands = getAllSlashCommands(),
): { embed: ResultContainer; rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const entries = allEntries(commands);
  const activeView: HelpView =
    view.kind === "home"
      ? view
      : query && view.kind !== "detail" && view.kind !== "search"
        ? { kind: "search", page: 0 }
        : query && view.kind === "category"
          ? { kind: "search", page: view.page }
          : view;

  const resolved = resolvePageEntries(activeView, entries, query);
  let embed: ResultContainer;

  if (activeView.kind === "home") {
    embed = buildHomeEmbed(entries, client, t, emojis);
  } else if (activeView.kind === "detail" && resolved.detail) {
    const label = query
      ? t("help.search.titleWithQuery", "Search: {query}", { query })
      : resolved.category
        ? categoryLabel(t, resolved.category)
        : t("help.commands", "Commands");
    embed = buildDetailEmbed(resolved.detail, label, client, t, emojis);
  } else if (query || activeView.kind === "search") {
    embed = buildSearchEmbed(
      resolved.pageEntries,
      query || "all",
      resolved.page,
      resolved.pageCount,
      resolved.embedEntries.length,
      client,
      t,
      emojis,
    );
  } else if (resolved.category) {
    embed = buildCategoryEmbed(
      resolved.category,
      resolved.pageEntries,
      resolved.page,
      resolved.pageCount,
      resolved.embedEntries.length,
      client,
      t,
      emojis,
    );
  } else {
    embed = buildHomeEmbed(entries, client, t, emojis);
  }

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    buildNavButtons(activeView, query, resolved.pageCount, t),
    buildHelpLinkRow(docsBaseUrl, resolved.docsPath, t),
  ];

  if (!query) {
    rows.push(buildCategorySelect(activeView, query, entries, t));
  }

  const commandSelect = buildCommandSelect(activeView, query, resolved.pageEntries, t);
  if (commandSelect) rows.push(commandSelect);

  // Discord allows max 5 rows.
  return { embed, rows: rows.slice(0, 5) };
}

export function buildHelpMessage(
  pageIndex: number,
  query: string,
  docsBaseUrl: string,
  ephemeral: boolean,
  client: Client,
  t: Translator,
  emojis?: EmojisConfig,
  commands = getAllSlashCommands(),
): InteractionReplyOptions {
  const view: HelpView = query ? { kind: "search", page: Math.max(0, pageIndex) } : { kind: "home" };
  const { embed, rows } = buildHelpPayload(view, query.trim(), docsBaseUrl, client, t, emojis, commands);
  return containerReply(embed, ephemeral, rows);
}

export function buildHelpUpdate(
  view: HelpView,
  query: string,
  docsBaseUrl: string,
  client: Client,
  t: Translator,
  emojis?: EmojisConfig,
  commands = getAllSlashCommands(),
): InteractionUpdateOptions {
  const { embed, rows } = buildHelpPayload(view, query.trim(), docsBaseUrl, client, t, emojis, commands);
  return containerEdit(embed, rows);
}

function parseHelpInteraction(
  customId: string,
  selectValue?: string,
): ParsedHelpAction | null {
  const parsed = parseCustomId(customId);
  if (!parsed) return null;

  if (selectValue !== undefined) {
    return { type: "select", value: selectValue, view: parsed.view, query: parsed.query };
  }

  if (parsed.action === "go" || parsed.action === "prev" || parsed.action === "next") {
    return { type: "button", view: parsed.view, query: parsed.query };
  }

  return null;
}

async function applyHelpInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  action: ParsedHelpAction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
): Promise<void> {
  const entries = allEntries();
  let view = action.view;
  const query = action.query;

  if (action.type === "select") {
    const resolved = resolvePageEntries(view.kind === "detail" ? { kind: "category", categoryId: view.categoryId, page: view.page } : view, entries, query);
    view = resolveViewFromSelect(action.value, view, resolved.pageEntries);
  }

  const { t } = await translatorFor(interaction.user.id);
  await interaction.update(buildHelpUpdate(view, query, docsBaseUrl, interaction.client, t, emojis));
}

export async function handleHelpButton(
  interaction: ButtonInteraction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
): Promise<void> {
  const parsed = parseHelpInteraction(interaction.customId);
  if (!parsed || parsed.type !== "button") return;
  await applyHelpInteraction(interaction, parsed, docsBaseUrl, emojis);
}

export async function handleHelpSelect(
  interaction: StringSelectMenuInteraction,
  docsBaseUrl: string,
  emojis?: EmojisConfig,
): Promise<void> {
  const value = interaction.values[0];
  if (!value) return;
  const parsed = parseHelpInteraction(interaction.customId, value);
  if (!parsed || parsed.type !== "select") return;
  await applyHelpInteraction(interaction, parsed, docsBaseUrl, emojis);
}
