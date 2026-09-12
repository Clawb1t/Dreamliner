import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type InteractionUpdateOptions,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { containerEdit, guildResultOptions, resultReply } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import { canUseUtility } from "../../../core/guildHelpers.js";
import { BanMembers } from "./commandHelpers.js";
import {
  buildBanSearchContainer,
  buildMemberSearchContainer,
  searchBans,
  searchMembers,
  type BanSearchResult,
  type SearchResult,
  type SearchSort,
} from "./search.js";

const log = getLogger("utility:search");

export const SEARCH_PREFIX = "dl:search";

export type MemberSearchState = {
  kind: "m";
  page: number;
  inVoice: boolean;
  botsOnly: boolean;
  caseSensitive: boolean;
  regex: boolean;
  sort: SearchSort;
  query: string;
};

export type BanSearchState = {
  kind: "b";
  page: number;
  caseSensitive: boolean;
  regex: boolean;
  query: string;
};

export type SearchState = MemberSearchState | BanSearchState;

const SORT_CODE: Record<SearchSort, string> = { name: "n", joined: "j", created: "c", role: "r" };
const SORT_FROM_CODE: Record<string, SearchSort> = { n: "name", j: "joined", c: "created", r: "role" };

function flag(value: boolean): string {
  return value ? "1" : "0";
}

/** Every field before the query is fixed-width, and the query — free text, so the only part
 * that could itself contain a `:` — always comes last. Parsing splits from the left for the
 * fixed fields and rejoins whatever's left as the query, so a colon in someone's search text
 * can't desync the format. A very long customId is truncated at 100 chars (Discord's limit),
 * which can only ever cut into the trailing query, same as the stats UI's state encoding. */
export function buildSearchCustomId(state: SearchState): string {
  const parts =
    state.kind === "m"
      ? [
          SEARCH_PREFIX,
          "m",
          String(state.page),
          flag(state.inVoice),
          flag(state.botsOnly),
          flag(state.caseSensitive),
          flag(state.regex),
          SORT_CODE[state.sort],
          state.query,
        ]
      : [SEARCH_PREFIX, "b", String(state.page), flag(state.caseSensitive), flag(state.regex), state.query];
  return parts.join(":").slice(0, 100);
}

export function parseSearchCustomId(customId: string): SearchState | null {
  if (!customId.startsWith(`${SEARCH_PREFIX}:`)) return null;
  const parts = customId.slice(SEARCH_PREFIX.length + 1).split(":");
  const kind = parts[0];
  const page = Number(parts[1]);
  if (!Number.isFinite(page) || page < 1) return null;

  if (kind === "m" && parts.length >= 8) {
    return {
      kind: "m",
      page,
      inVoice: parts[2] === "1",
      botsOnly: parts[3] === "1",
      caseSensitive: parts[4] === "1",
      regex: parts[5] === "1",
      sort: SORT_FROM_CODE[parts[6] ?? "n"] ?? "name",
      query: parts.slice(7).join(":"),
    };
  }
  if (kind === "b" && parts.length >= 4) {
    return {
      kind: "b",
      page,
      caseSensitive: parts[2] === "1",
      regex: parts[3] === "1",
      query: parts.slice(4).join(":"),
    };
  }
  return null;
}

function paginationRow(state: SearchState, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  const prev: SearchState = { ...state, page: Math.max(1, state.page - 1) };
  const next: SearchState = { ...state, page: Math.min(totalPages, state.page + 1) };
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildSearchCustomId(prev))
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildSearchCustomId(next))
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.page >= totalPages),
  );
}

type SearchPayload = {
  container: ReturnType<typeof buildMemberSearchContainer>;
  rows: ActionRowBuilder<MessageActionRowComponentBuilder>[];
};

/** Builds the container + pagination row for an already-fetched member search result. Shared by
 * the `/search` command (which needs the raw result first, to special-case zero/one results) and
 * the Previous/Next button handler below (which only ever shows the paginated list). */
export function memberSearchPayload(
  state: MemberSearchState,
  result: SearchResult,
  client: Client,
  guildConfig: GuildConfig,
): SearchPayload {
  const container = buildMemberSearchContainer(client, guildConfig, result, state.query, state.sort);
  const rows =
    result.totalPages > 1 ? [paginationRow({ ...state, page: result.page }, result.totalPages)] : [];
  return { container, rows };
}

/** Same as `memberSearchPayload`, for `/bansearch`. */
export function banSearchPayload(
  state: BanSearchState,
  result: BanSearchResult,
  client: Client,
  guildConfig: GuildConfig,
): SearchPayload {
  const container = buildBanSearchContainer(
    client,
    guildConfig,
    result.bans,
    result.page,
    result.totalPages,
    result.total,
    result.from,
    state.query,
  );
  const rows =
    result.totalPages > 1 ? [paginationRow({ ...state, page: result.page }, result.totalPages)] : [];
  return { container, rows };
}

async function buildSearchUpdate(
  state: SearchState,
  guild: Guild,
  client: Client,
  guildConfig: GuildConfig,
): Promise<InteractionUpdateOptions> {
  const { container, rows } =
    state.kind === "m"
      ? memberSearchPayload(
          state,
          await searchMembers(guild, {
            query: state.query,
            page: state.page,
            inVoice: state.inVoice,
            botsOnly: state.botsOnly,
            caseSensitive: state.caseSensitive,
            regex: state.regex,
            sort: state.sort,
          }),
          client,
          guildConfig,
        )
      : banSearchPayload(
          state,
          await searchBans(guild, {
            query: state.query,
            page: state.page,
            caseSensitive: state.caseSensitive,
            regex: state.regex,
          }),
          client,
          guildConfig,
        );
  return containerEdit(container, rows);
}

/** Handles Previous/Next clicks on a search or bansearch result. Re-checks permissions on every
 * click rather than trusting whoever the message was originally sent to still qualifies — a
 * role can be pulled between page loads. */
export async function handleSearchInteraction(
  interaction: ButtonInteraction,
  guildConfig: GuildConfig,
  guildMember: GuildMember,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${SEARCH_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guild) return true;

  const state = parseSearchCustomId(interaction.customId);
  if (!state) return true;

  const allowed = await canUseUtility(interaction.guildId!, guildConfig, "can_search", guildMember);
  if (!allowed) {
    await interaction.reply(
      resultReply(
        "Permission denied",
        "You do not have permission to use this command.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  if (state.kind === "b" && !guildMember.permissions.has(BanMembers)) {
    await interaction.reply(
      resultReply(
        "Missing permission",
        "You need the **Ban Members** permission.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  try {
    await interaction.update(await buildSearchUpdate(state, interaction.guild, interaction.client, guildConfig));
  } catch (error) {
    log.error("Search pagination error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Error",
            "Could not load that page.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
  }

  return true;
}
