import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SlashCommandStringOption,
  type SlashCommandSubcommandBuilder,
  type TopLevelComponentData,
} from "discord.js";
import { baseEmbed } from "../../../../core/embeds.js";
import { requirePluginPermission } from "../../../../core/pluginCommand.js";
import type { SlashCommandContext, SlashCommandDefinition } from "../../../../core/types.js";
import type { Translator } from "../../../../i18n/index.js";
import { CARD_TYPE_META, CARD_TYPES, getPlaneTypeById, isCardType, searchPlaneTypes } from "../../functions/catalog.js";
import {
  LEADERBOARD_BOARDS,
  LIVERIES,
  RARITIES,
  RARITY_META,
  ROUTES,
  isLivery,
  isRarity,
  marketFee,
  type LeaderboardBoard,
  type Livery,
  type Rarity,
  type RouteKey,
} from "../constants.js";
import { craftCard, getCopy, giveCopy, hangarCapacity, listCopyEvents, repaintCopy, salvageCopies, setShowcase, upgradeCopy } from "../copies.js";
import { HangarError } from "../errors.js";
import { claimFlights, isRouteKey, listActiveFlights, startFlight } from "../flights.js";
import { hangarMembersOf } from "../guildMembers.js";
import { getPartsBalance } from "../ledger.js";
import { globalFleetRank, leaderboard } from "../leaderboards.js";
import { browseListings, buyListing, cancelListing, createListing, listUserListings } from "../market.js";
import { claimBoardingPass, listPacks, normalizedOdds, openPack } from "../packs.js";
import { pilotRankView } from "../score.js";
import { catalogView, hangarCollection, setsProgress } from "../service.js";
import { getUserState } from "../state.js";
import { createTrade, listTrades } from "../trades.js";
import { copyView, viewContext, type HangarCopyView } from "../view.js";
import { HE } from "./emojis.js";
import { canViewCrossServerData, listHiddenFromGlobalBoards } from "../../../../core/privacy/ghostMode.js";
import { withoutHidden } from "../../../../core/privacy/policy.js";
import { APP_EMOJI } from "../../../../core/appEmojis.js";
import { resultReply, slashResultOptions } from "../../../../core/responses.js";
import { buildHangarPage, buildTradeMessage, buildTradeRow } from "./pages.js";
import {
  HANGAR_PREFIX,
  button,
  coins,
  coinsLabel,
  copyLine,
  errorMessage,
  liveryLabel,
  notice,
  parts,
  rarityLabel,
  relTime,
  renderGallery,
  renderTypeGallery,
  row,
  statsText,
  v2,
  type V2Message,
} from "./views.js";

const NO_PINGS = { parse: [] as never[] };

async function send(ctx: SlashCommandContext, message: V2Message, opts: { deferred?: boolean; ping?: string[] } = {}): Promise<void> {
  const allowedMentions = opts.ping ? { parse: [] as never[], users: opts.ping } : NO_PINGS;
  if (opts.deferred || ctx.interaction.deferred) {
    await ctx.interaction.editReply({ components: message.components, files: message.files, flags: MessageFlags.IsComponentsV2, allowedMentions });
    return;
  }
  await ctx.interaction.reply({ components: message.components, files: message.files, flags: message.flags, allowedMentions });
}

/** Runs a Hangar action and turns rule errors into a friendly reply. */
async function guarded(ctx: SlashCommandContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = errorMessage(error, ctx.t, true);
    if (!message) throw error;
    if (ctx.interaction.deferred || ctx.interaction.replied) {
      await ctx.interaction.editReply({ components: message.components, files: [], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS });
    } else {
      await ctx.interaction.reply({ components: message.components, flags: message.flags, allowedMentions: NO_PINGS });
    }
  }
}

function copyOption(o: SlashCommandStringOption, name: string, description: string, required = true) {
  return o.setName(name).setDescription(description).setRequired(required).setAutocomplete(true);
}

function sub(s: SlashCommandSubcommandBuilder, name: string, description: string) {
  return s.setName(name).setDescription(description);
}

const ROUTE_CHOICES = (["short", "medium", "long"] as const).map((key) => ({
  name: `${ROUTES[key].label} (${Math.round(ROUTES[key].durationMs / 3_600_000)}h)`,
  value: key,
}));

const BOARD_LABELS: Record<LeaderboardBoard, string> = {
  fleet_value: "Fleet Value",
  rarest: "Rarest card",
  sets: "Sets completed",
  flights_weekly: "Flights this week",
};

const data = new SlashCommandBuilder()
  .setName("planes")
  .setDescription("The Hangar: collect, fly, trade and rank plane and airline cards")
  .addSubcommand((s) =>
    sub(s, "hangar", "Browse a hangar (card collection)").addUserOption((o) => o.setName("user").setDescription("Member to view")),
  )
  .addSubcommand((s) => sub(s, "boarding", "Claim your free daily boarding pass (one card)"))
  .addSubcommand((s) => sub(s, "salvage", "Salvage a card for Parts").addStringOption((o) => copyOption(o, "copy", "Card to salvage")))
  .addSubcommand((s) => sub(s, "craft", "Craft a card with Parts").addStringOption((o) => copyOption(o, "card", "Card to craft")))
  .addSubcommand((s) => sub(s, "repaint", "Repaint a card for a chance at a better livery").addStringOption((o) => copyOption(o, "copy", "Card to repaint")))
  .addSubcommand((s) => sub(s, "upgrade", "Spend Parts to level a card up").addStringOption((o) => copyOption(o, "copy", "Card to upgrade")))
  .addSubcommand((s) => sub(s, "rank", "Show a Pilot Rank and Fleet Value").addUserOption((o) => o.setName("user").setDescription("Member to view")))
  .addSubcommand((s) =>
    sub(s, "leaderboard", "Top collectors")
      .addStringOption((o) =>
        o
          .setName("board")
          .setDescription("Which leaderboard")
          .addChoices(...LEADERBOARD_BOARDS.map((b) => ({ name: BOARD_LABELS[b], value: b }))),
      )
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Everyone, or this server only")
          .addChoices({ name: "Global", value: "global" }, { name: "This server", value: "server" }),
      ),
  )
  .addSubcommand((s) => sub(s, "sets", "Set (fleet) progress").addUserOption((o) => o.setName("user").setDescription("Member to view")))
  .addSubcommand((s) =>
    sub(s, "showcase", "Pick up to 3 cards to show on your profile (leave empty to clear)")
      .addStringOption((o) => copyOption(o, "first", "First card", false))
      .addStringOption((o) => copyOption(o, "second", "Second card", false))
      .addStringOption((o) => copyOption(o, "third", "Third card", false)),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("pack")
      .setDescription("Card packs")
      .addSubcommand((s) => sub(s, "list", "Pack tiers, prices and odds"))
      .addSubcommand((s) => sub(s, "open", "Buy and open a pack with global coins").addStringOption((o) => copyOption(o, "tier", "Pack tier"))),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("card")
      .setDescription("Cards and copies")
      .addSubcommand((s) =>
        sub(s, "view", "View a card from the catalog")
          .addStringOption((o) => copyOption(o, "card", "Card"))
          .addStringOption((o) =>
            o
              .setName("livery")
              .setDescription("Livery to preview")
              .addChoices(...LIVERIES.map((l) => ({ name: l[0]!.toUpperCase() + l.slice(1), value: l }))),
          ),
      )
      .addSubcommand((s) => sub(s, "inspect", "Inspect one of your numbered cards").addStringOption((o) => copyOption(o, "copy", "Card")))
      .addSubcommand((s) =>
        sub(s, "give", "Give one of your cards to another member")
          .addUserOption((o) => o.setName("user").setDescription("Member to give it to").setRequired(true))
          .addStringOption((o) => copyOption(o, "copy", "Card to give")),
      )
      .addSubcommand((s) =>
        sub(s, "list", "List cards in the catalog")
          .addStringOption((o) =>
            o
              .setName("rarity")
              .setDescription("Filter by rarity")
              .addChoices(...RARITIES.map((r) => ({ name: RARITY_META[r].label, value: r }))),
          )
          .addStringOption((o) =>
            o
              .setName("type")
              .setDescription("Filter by card type")
              .addChoices(...CARD_TYPES.map((t) => ({ name: CARD_TYPE_META[t].label, value: t }))),
          ),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("fly")
      .setDescription("Flights")
      .addSubcommand((s) =>
        sub(s, "start", "Send a plane on a route")
          .addStringOption((o) => copyOption(o, "copy", "Plane to fly"))
          .addStringOption((o) => o.setName("route").setDescription("Route").setRequired(true).addChoices(...ROUTE_CHOICES))
          .addStringOption((o) => copyOption(o, "operator", "Airline card to operate it (bonus Parts)", false)),
      )
      .addSubcommand((s) => sub(s, "claim", "Collect rewards from landed flights"))
      .addSubcommand((s) => sub(s, "status", "Your flights in the air")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("trade")
      .setDescription("Trades")
      .addSubcommand((s) =>
        sub(s, "offer", "Offer a trade to another member")
          .addUserOption((o) => o.setName("user").setDescription("Who to trade with").setRequired(true))
          .addStringOption((o) => copyOption(o, "give1", "A card you give", false))
          .addStringOption((o) => copyOption(o, "give2", "A card you give", false))
          .addStringOption((o) => copyOption(o, "give3", "A card you give", false))
          .addStringOption((o) => copyOption(o, "want1", "A card you want from them", false))
          .addStringOption((o) => copyOption(o, "want2", "A card you want from them", false))
          .addStringOption((o) => copyOption(o, "want3", "A card you want from them", false))
          .addNumberOption((o) => o.setName("coins").setDescription("Global coins you add").setMinValue(0))
          .addNumberOption((o) => o.setName("ask_coins").setDescription("Global coins you ask for").setMinValue(0)),
      )
      .addSubcommand((s) => sub(s, "view", "Your open trades")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("market")
      .setDescription("The card market")
      .addSubcommand((s) =>
        sub(s, "list", "List a card for sale")
          .addStringOption((o) => copyOption(o, "copy", "Card to sell"))
          .addNumberOption((o) => o.setName("price").setDescription("Price in global coins").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) =>
        sub(s, "browse", "Browse cards for sale")
          .addStringOption((o) =>
            o
              .setName("rarity")
              .setDescription("Filter by rarity")
              .addChoices(...RARITIES.map((r) => ({ name: RARITY_META[r].label, value: r }))),
          )
          .addStringOption((o) =>
            o
              .setName("livery")
              .setDescription("Filter by livery")
              .addChoices(...LIVERIES.map((l) => ({ name: l[0]!.toUpperCase() + l.slice(1), value: l }))),
          )
          .addNumberOption((o) => o.setName("max_price").setDescription("Highest price").setMinValue(0))
          .addStringOption((o) =>
            o
              .setName("sort")
              .setDescription("Order")
              .addChoices(
                { name: "Newest", value: "newest" },
                { name: "Cheapest", value: "price_asc" },
                { name: "Most expensive", value: "price_desc" },
              ),
          )
          .addIntegerOption((o) => o.setName("page").setDescription("Page").setMinValue(1)),
      )
      .addSubcommand((s) =>
        sub(s, "buy", "Buy a listing").addIntegerOption((o) => o.setName("listing").setDescription("Listing number").setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) => sub(s, "cancel", "Take your card off the market").addStringOption((o) => copyOption(o, "listing", "Your listing"))),
  );

// ── Autocomplete ─────────────────────────────────────────────────────────────

const COPY_OPTIONS = new Set(["copy", "first", "second", "third", "give1", "give2", "give3", "operator"]);

function copyChoice(view: HangarCopyView): { name: string; value: string } {
  const tags = [view.card.name, view.serialLabel, RARITY_META[view.card.rarity]?.label ?? view.card.rarity];
  if (view.livery !== "standard") tags.push(view.livery === "gold" ? "Gold" : "Prototype");
  tags.push(`Lv ${view.level}`);
  if (view.locked) tags.push(`busy: ${view.locked.reason}`);
  return { name: tags.join(" · ").slice(0, 100), value: String(view.id) };
}

export async function handlePlanesAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? "").trim();
  const group = interaction.options.getSubcommandGroup(false);
  const subName = interaction.options.getSubcommand(false);

  if (focused.name === "tier") {
    const packs = listPacks({ activeOnly: true }).filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()));
    await interaction.respond(packs.slice(0, 25).map((p) => ({ name: `${p.name} (${p.size} cards, ${coinsLabel(p.price)})`.slice(0, 100), value: p.key })));
    return;
  }

  if (focused.name === "card") {
    const craftOnly = !group && subName === "craft";
    const matches = searchPlaneTypes(query, 50, { enabledOnly: craftOnly });
    const filtered = craftOnly ? matches.filter((c) => c.printRun == null && !c.retiredAt && RARITY_META[c.rarity as Rarity]?.craft != null) : matches;
    await interaction.respond(
      filtered.slice(0, 25).map((c) => {
        const cost = RARITY_META[c.rarity as Rarity]?.craft;
        const label = craftOnly && cost ? `${c.name} (${cost} Parts)` : `${c.name} (${RARITY_META[c.rarity as Rarity]?.label ?? c.rarity})`;
        return { name: label.slice(0, 100), value: String(c.id) };
      }),
    );
    return;
  }

  if (focused.name === "listing") {
    const ctx = viewContext();
    const listings = listUserListings(interaction.user.id, 50).filter((l) => l.status === "active");
    const out: { name: string; value: string }[] = [];
    for (const listing of listings) {
      const copy = getCopy(listing.copyId);
      const view = copy ? copyView(copy, ctx) : null;
      if (!view) continue;
      out.push({ name: `#${listing.id} ${view.card.name} ${view.serialLabel} for ${coinsLabel(listing.price)}`.slice(0, 100), value: String(listing.id) });
    }
    await interaction.respond(out.slice(0, 25));
    return;
  }

  const isWant = /^want[123]$/.test(focused.name);
  if (COPY_OPTIONS.has(focused.name) || isWant) {
    let ownerId = interaction.user.id;
    if (isWant) {
      const target = interaction.options.get("user")?.value;
      if (typeof target !== "string") {
        await interaction.respond([]);
        return;
      }
      ownerId = target;
    }
    const filters: Parameters<typeof hangarCollection>[1] = { q: query || null, sort: "rarity", pageSize: 25 };
    if (focused.name === "operator") filters.cardType = "airline";
    else if (group === "fly") filters.cardType = "plane";
    // Actions need a free card, so only free ones are offered; inspecting and the showcase take any.
    filters.locked = (group === "card" && subName === "inspect") || (!group && subName === "showcase") ? null : false;
    const result = hangarCollection(ownerId, filters);
    await interaction.respond(result.copies.map(copyChoice));
    return;
  }

  await interaction.respond([]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyIdOption(i: ChatInputCommandInteraction, name: string, required = true): number | null {
  const raw = required ? i.options.getString(name, true) : i.options.getString(name);
  if (!raw) return null;
  const id = Number(raw.replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : -1;
}

function progressBar(progress: number, width = 12): string {
  const filled = Math.round(progress * width);
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\``;
}

function summaryContainer(title: string, lines: string[], buttons?: ReturnType<typeof row>[]): TopLevelComponentData {
  return baseEmbed().setTitle(title).setDescription(lines.filter(Boolean).join("\n")).toContainerComponent(buttons);
}

function newSetsLine(sets: { name: string; bonusParts: number }[], t: Translator): string {
  if (!sets.length) return "";
  return sets
    .map((s) => `${HE.sets} ${t("economy.hangar.setCompleted", "Set completed: **{name}** (+{parts} Parts)", { name: s.name, parts: s.bonusParts })}`)
    .join("\n");
}

// ── Execute ──────────────────────────────────────────────────────────────────

async function execute(ctx: SlashCommandContext): Promise<void> {
  const i = ctx.interaction;
  const group = i.options.getSubcommandGroup(false);
  const name = i.options.getSubcommand();
  const t = ctx.t;
  const userId = i.user.id;

  const need = async (flag: string) => Boolean(await requirePluginPermission(ctx, "economy", flag));
  /** The Hangar is one collection across every server: someone else's under Ghost Mode stays
   *  private (core/privacy). Replies and returns true when blocked. */
  const ghosted = async (target: { id: string }) => {
    if (target.id === userId || canViewCrossServerData(userId, target.id) !== "hidden") return false;
    await i.reply(
      resultReply(
        t("economy.ghostTitle", "Ghost Mode is on"),
        t("economy.hangar.ghostBody", "<@{user}> has chosen to keep their activity across servers private, including their Hangar.", { user: target.id }),
        true,
        slashResultOptions(ctx, { emoji: APP_EMOJI.locked }),
      ),
    );
    return true;
  };

  // ── /planes hangar ──
  if (!group && name === "hangar") {
    if (!(await need("can_view"))) return;
    const target = i.options.getUser("user") ?? i.user;
    if (await ghosted(target)) return;
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    await guarded(ctx, async () => {
      const page = await buildHangarPage({ viewerId: userId, targetId: target.id, targetName: target.displayName, index: 0, t });
      await send(ctx, page, { deferred: true });
    });
    return;
  }

  // ── /planes boarding ──
  if (!group && name === "boarding") {
    if (!(await need("can_boarding"))) return;
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    await guarded(ctx, async () => {
      const result = claimBoardingPass(userId, i.guildId!);
      const { gallery, files } = await renderGallery(result.copies.map((c) => c.copy));
      const views = result.copies.map((c) => copyView(c.copy, viewContext())).filter((v): v is HangarCopyView => Boolean(v));
      const lines = [
        ...views.map((v) => copyLine(v, t)),
        `${HE.streak} ${t("economy.hangar.boarding.streak", "Streak: {streak} days", { streak: result.streak })}`,
        result.streakBonusParts ? `${HE.parts} ${t("economy.hangar.boarding.bonus", "Streak bonus: +{parts} Parts", { parts: result.streakBonusParts })}` : "",
        newSetsLine(result.newlyCompletedSets, t),
        `-# ${t("economy.hangar.boarding.next", "Next boarding pass {time}", { time: relTime(result.nextAt) })}`,
      ];
      const container = summaryContainer(`${HE.boarding} ${t("economy.hangar.boarding.title", "Boarding pass")}`, lines);
      await send(ctx, v2(gallery ? [gallery, container] : [container], files), { deferred: true });
    });
    return;
  }

  // ── /planes salvage ──
  if (!group && name === "salvage") {
    if (!(await need("can_salvage"))) return;
    await guarded(ctx, async () => {
      const copyId = copyIdOption(i, "copy")!;
      const before = getCopy(copyId);
      const view = before ? copyView(before, viewContext()) : null;
      const result = salvageCopies(userId, [copyId]);
      await send(
        ctx,
        notice(
          t("economy.hangar.salvage.title", "Salvaged"),
          t("economy.hangar.salvage.body", "Broke down {card} for {parts}.\nYou now have {balance}.", {
            card: view ? copyLine(view, t) : `#${copyId}`,
            parts: parts(result.parts),
            balance: parts(result.balance),
          }),
          "success",
          ctx.ephemeral,
        ),
      );
    });
    return;
  }

  // ── /planes craft ──
  if (!group && name === "craft") {
    if (!(await need("can_craft"))) return;
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    await guarded(ctx, async () => {
      const result = craftCard(userId, Number(i.options.getString("card", true)));
      const view = copyView(result.copy, viewContext())!;
      const { gallery, files } = await renderGallery([result.copy]);
      const container = summaryContainer(`${HE.craft} ${t("economy.hangar.craft.title", "Crafted")}`, [
        copyLine(view, t),
        t("economy.hangar.craft.cost", "Spent {cost}. You have {balance} left.", { cost: parts(result.cost), balance: parts(result.balance) }),
      ]);
      await send(ctx, v2(gallery ? [gallery, container] : [container], files), { deferred: true });
    });
    return;
  }

  // ── /planes repaint ──
  if (!group && name === "repaint") {
    if (!(await need("can_repaint"))) return;
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    await guarded(ctx, async () => {
      const result = repaintCopy(userId, copyIdOption(i, "copy")!);
      const view = copyView(result.copy, viewContext())!;
      const { gallery, files } = await renderGallery([result.copy]);
      const changed = result.from !== result.to;
      const container = summaryContainer(`${HE.repaint} ${t("economy.hangar.repaint.title", "Repaint")}`, [
        copyLine(view, t),
        changed
          ? t("economy.hangar.repaint.changed", "New livery: **{livery}**!", { livery: liveryLabel(result.to, t) })
          : t("economy.hangar.repaint.same", "No luck this time, it kept its {livery} livery.", { livery: liveryLabel(result.from, t) }),
        t("economy.hangar.repaint.cost", "Cost {cost}. Balance {balance}.", { cost: coins(result.cost), balance: coins(result.balance) }),
      ]);
      await send(ctx, v2(gallery ? [gallery, container] : [container], files), { deferred: true });
    });
    return;
  }

  // ── /planes upgrade ──
  if (!group && name === "upgrade") {
    if (!(await need("can_upgrade"))) return;
    await guarded(ctx, async () => {
      const result = upgradeCopy(userId, copyIdOption(i, "copy")!);
      const view = copyView(result.copy, viewContext())!;
      await send(
        ctx,
        notice(
          t("economy.hangar.upgrade.title", "Level up"),
          t("economy.hangar.upgrade.body", "{card}\nSpent {cost}. You have {balance} left.", {
            card: copyLine(view, t),
            cost: parts(result.cost),
            balance: parts(result.balance),
          }),
          "success",
          ctx.ephemeral,
        ),
      );
    });
    return;
  }

  // ── /planes rank ──
  if (!group && name === "rank") {
    if (!(await need("can_view"))) return;
    const target = i.options.getUser("user") ?? i.user;
    if (await ghosted(target)) return;
    const state = getUserState(target.id);
    const fleet = state?.fleetValue ?? 0;
    const rank = pilotRankView(fleet);
    const position = globalFleetRank(target.id);
    const lines = [
      `${HE.rank} **${t(`economy.hangar.rank.${rank.key}`, rank.label)}**`,
      `${t("economy.hangar.fleetValue", "Fleet Value")} \`${fleet.toLocaleString("en-US")}\`${position ? `  ${t("economy.hangar.globalPosition", "Global #{rank}", { rank: position })}` : ""}`,
      rank.next
        ? `${progressBar(rank.progress)} ${t("economy.hangar.rank.next", "{points} to {rank}", { points: (rank.next.minFleetValue - fleet).toLocaleString("en-US"), rank: t(`economy.hangar.rank.${rank.next.key}`, rank.next.label) })}`
        : t("economy.hangar.rank.top", "Top rank reached."),
      `${t("economy.hangar.copies", "Cards")} \`${state?.copiesCount ?? 0}\`  ${t("economy.hangar.distinct", "Distinct")} \`${state?.distinctCards ?? 0}\`  ${t("economy.hangar.setsCompleted", "Sets")} \`${state?.setsCompleted ?? 0}\``,
    ];
    await send(ctx, v2([baseEmbed().setTitle(target.displayName).setThumbnail(target.displayAvatarURL()).setDescription(lines.join("\n")).toContainerComponent()], [], ctx.ephemeral));
    return;
  }

  // ── /planes leaderboard ──
  if (!group && name === "leaderboard") {
    if (!(await need("can_view"))) return;
    const boardRaw = i.options.getString("board") ?? "fleet_value";
    const board = (LEADERBOARD_BOARDS as readonly string[]).includes(boardRaw) ? (boardRaw as LeaderboardBoard) : "fleet_value";
    const scope = i.options.getString("scope") ?? "global";
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    const memberIds = scope === "server" && i.guild ? await hangarMembersOf(i.guild) : null;
    // Ghost Mode users are left off and the rest renumbered.
    const entries = withoutHidden(leaderboard(board, { memberIds, limit: 40 }), listHiddenFromGlobalBoards(), 15);
    const lines = entries.length
      ? entries.map((e) => `\`#${e.rank}\` <@${e.userId}>  \`${e.value.toLocaleString("en-US")}\``)
      : [t("economy.hangar.leaderboard.empty", "Nobody here yet. Open a pack to get started.")];
    const title = `${HE.trophy} ${t(`economy.hangar.board.${board}`, BOARD_LABELS[board])}${scope === "server" ? ` · ${i.guild?.name ?? ""}` : ""}`;
    await send(ctx, v2([summaryContainer(title, lines)]), { deferred: true });
    return;
  }

  // ── /planes sets ──
  if (!group && name === "sets") {
    if (!(await need("can_view"))) return;
    const target = i.options.getUser("user") ?? i.user;
    if (await ghosted(target)) return;
    const sets = setsProgress(target.id);
    const lines = sets.length
      ? sets.map(
          (s) =>
            `${s.completed ? HE.success : HE.sets} **${s.name}** \`${s.owned}/${s.total}\`${s.bonusParts ? `  -# ${t("economy.hangar.sets.bonus", "{parts} Parts bonus", { parts: s.bonusParts })}` : ""}`,
        )
      : [t("economy.hangar.sets.none", "No sets yet.")];
    await send(ctx, v2([summaryContainer(`${HE.sets} ${t("economy.hangar.sets.title", "{user}'s sets", { user: target.displayName })}`, lines)], [], ctx.ephemeral));
    return;
  }

  // ── /planes showcase ──
  if (!group && name === "showcase") {
    if (!(await need("can_view"))) return;
    await guarded(ctx, async () => {
      const ids = ["first", "second", "third"].map((n) => copyIdOption(i, n, false)).filter((id): id is number => id !== null);
      const saved = setShowcase(userId, ids);
      await send(
        ctx,
        notice(
          t("economy.hangar.showcase.title", "Showcase updated"),
          saved.length
            ? t("economy.hangar.showcase.body", "Showing {count} cards on your profile.", { count: saved.length })
            : t("economy.hangar.showcase.cleared", "Your showcase is empty now."),
          "success",
          true,
        ),
      );
    });
    return;
  }

  // ── /planes pack list ──
  if (group === "pack" && name === "list") {
    if (!(await need("can_buy_pack"))) return;
    const packs = listPacks({ activeOnly: true });
    const lines = packs.map((p) => {
      const odds = normalizedOdds(p.rarityOdds);
      const oddsText = RARITIES.filter((r) => odds[r] > 0)
        .map((r) => `${rarityLabel(r, t)} ${(odds[r] * 100).toFixed(odds[r] < 0.01 ? 1 : 0)}%`)
        .join(", ");
      const extras = [
        p.guaranteeRarity ? t("economy.hangar.pack.guarantee", "{rarity}+ guaranteed", { rarity: rarityLabel(p.guaranteeRarity, t) }) : "",
        p.pityRarity && p.pityAfter ? t("economy.hangar.pack.pity", "{rarity} within {count} cards", { rarity: rarityLabel(p.pityRarity, t), count: p.pityAfter }) : "",
        p.endsAt ? t("economy.hangar.pack.ends", "ends {time}", { time: relTime(p.endsAt) }) : "",
      ].filter(Boolean);
      return `${HE.pack} **${p.name}** ${coins(p.price)} · ${p.size} ${t("economy.hangar.cards", "cards")}${extras.length ? ` · ${extras.join(", ")}` : ""}\n-# ${oddsText}`;
    });
    const buttons = packs.slice(0, 5).map((p) => button(`${HANGAR_PREFIX}pko:${userId}:${p.key}`, `${p.name} (${coinsLabel(p.price)})`, ButtonStyle.Primary, HE.pack));
    const container = summaryContainer(
      `${HE.pack} ${t("economy.hangar.pack.listTitle", "Packs")}`,
      lines.length ? lines : [t("economy.hangar.pack.none", "No packs are on sale right now.")],
      buttons.length ? [row(...buttons)] : undefined,
    );
    await send(ctx, v2([container], [], ctx.ephemeral));
    return;
  }

  // ── /planes pack open ──
  if (group === "pack" && name === "open") {
    if (!(await need("can_buy_pack"))) return;
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    await guarded(ctx, async () => {
      const message = await packRevealMessage(userId, i.guildId!, i.options.getString("tier", true), t);
      await send(ctx, message, { deferred: true });
    });
    return;
  }

  // ── /planes card view ──
  if (group === "card" && name === "view") {
    if (!(await need("can_view"))) return;
    const card = getPlaneTypeById(Number(i.options.getString("card", true)));
    if (!card) {
      await send(ctx, notice(t("economy.card.notFound.title", "Not found"), t("economy.hangar.cardMissing", "That card doesn't exist."), "error"));
      return;
    }
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    const liveryRaw = i.options.getString("livery");
    const livery: Livery = isLivery(liveryRaw) ? liveryRaw : "standard";
    const view = catalogView({ includeDisabled: true }).find((c) => c.id === card.id)!;
    const { gallery, files } = await renderTypeGallery(card.id, livery);
    const lines = [
      `${rarityLabel(view.rarity, t)} · ${t(`economy.cardType.${view.cardType}`, CARD_TYPE_META[view.cardType].label)}${view.subtitle ? ` · ${view.subtitle}` : ""}`,
      `${t("economy.hangar.minted", "Minted")} \`${view.minted}${view.printRun ? `/${view.printRun}` : ""}\`${view.retired ? ` · ${t("economy.hangar.retired", "Retired")}` : ""}${!view.enabled ? ` · ${t("economy.hangar.notInPacks", "Not in packs")}` : ""}`,
      view.craftCost != null ? `${HE.craft} ${t("economy.hangar.craftCost", "Craft for {parts}", { parts: parts(view.craftCost) })}` : "",
    ];
    await send(ctx, v2(gallery ? [gallery, summaryContainer(view.name, lines)] : [summaryContainer(view.name, lines)], files), { deferred: true });
    return;
  }

  // ── /planes card inspect ──
  if (group === "card" && name === "inspect") {
    if (!(await need("can_view"))) return;
    const copy = getCopy(copyIdOption(i, "copy")!);
    const view = copy ? copyView(copy, viewContext()) : null;
    if (!copy || !view) {
      await send(ctx, notice(t("economy.card.notFound.title", "Not found"), t("economy.hangar.copyMissing", "That card copy doesn't exist."), "error"));
      return;
    }
    await i.deferReply({ flags: ctx.ephemeral ? MessageFlags.Ephemeral : undefined });
    const { gallery, files } = await renderGallery([copy]);
    const history = listCopyEvents(copy.id, 5).map((e) => `-# ${e.kind.replace(/_/g, " ")} ${relTime(e.createdAt)}`);
    const lines = [
      copyLine(view, t),
      statsText(view, t),
      `${t("economy.hangar.owner", "Owner")} <@${view.ownerId}> · ${t("economy.hangar.flights", "Flights")} \`${view.flights}\` · XP \`${view.xp}${view.xpForNextLevel ? `/${view.xpForNextLevel}` : ""}\``,
      `${HE.salvage} ${t("economy.hangar.salvageValue", "Salvage value {parts}", { parts: parts(view.salvageValue) })}`,
      ...history,
    ];
    await send(ctx, v2(gallery ? [gallery, summaryContainer(view.card.name, lines)] : [summaryContainer(view.card.name, lines)], files), { deferred: true });
    return;
  }

  // ── /planes card give ──
  if (group === "card" && name === "give") {
    if (!(await need("can_give"))) return;
    const target = i.options.getUser("user", true);
    if (target.bot) {
      await send(ctx, notice(t("economy.give.invalidGift.title", "Invalid gift"), t("economy.give.cantGiveBot", "You can't give a card to a bot."), "error"));
      return;
    }
    await guarded(ctx, async () => {
      const copy = giveCopy(userId, target.id, copyIdOption(i, "copy")!);
      const view = copyView(copy, viewContext())!;
      await send(
        ctx,
        notice(
          t("economy.give.given.title", "Card given"),
          t("economy.hangar.give.body", "Gave {card} to **{user}**.", { card: copyLine(view, t), user: target.username }),
          "success",
          ctx.ephemeral,
        ),
      );
    });
    return;
  }

  // ── /planes card list ──
  if (group === "card" && name === "list") {
    if (!(await need("can_view"))) return;
    const rarityRaw = i.options.getString("rarity");
    const typeRaw = i.options.getString("type");
    const cards = catalogView().filter(
      (c) => (!rarityRaw || !isRarity(rarityRaw) || c.rarity === rarityRaw) && (!typeRaw || !isCardType(typeRaw) || c.cardType === typeRaw),
    );
    const lines = cards
      .slice(0, 30)
      .map((c) => `**${c.name}** · ${rarityLabel(c.rarity, t)}${c.printRun ? ` · \`${c.minted}/${c.printRun}\`` : ""}${c.retired ? ` · ${t("economy.hangar.retired", "Retired")}` : ""}`);
    if (cards.length > 30) lines.push(t("economy.card.list.more", "*+{count} more...*", { count: cards.length - 30 }));
    await send(
      ctx,
      v2([summaryContainer(t("economy.card.list.titleAll", "Card catalog"), lines.length ? lines : [t("economy.card.list.empty", "No cards are available yet.")])], [], ctx.ephemeral),
    );
    return;
  }

  // ── /planes fly ... ──
  if (group === "fly") {
    if (!(await need("can_fly"))) return;
    if (name === "start") {
      await guarded(ctx, async () => {
        const route = i.options.getString("route", true);
        if (!isRouteKey(route)) throw new HangarError("invalid", "Unknown route.");
        const operator = copyIdOption(i, "operator", false);
        const flight = startFlight({ userId, copyId: copyIdOption(i, "copy")!, route: route as RouteKey, operatorCopyId: operator });
        const copy = getCopy(flight.copyId);
        const view = copy ? copyView(copy, viewContext()) : null;
        await send(
          ctx,
          notice(
            t("economy.hangar.fly.startedTitle", "Wheels up"),
            t("economy.hangar.fly.started", "{card} took off on the {route} route. Lands {time}.", {
              card: view ? copyLine(view, t) : `#${flight.copyId}`,
              route: ROUTES[route as RouteKey].label,
              time: relTime(flight.endsAt),
            }),
            "success",
            ctx.ephemeral,
          ),
        );
      });
      return;
    }
    if (name === "claim") {
      await guarded(ctx, async () => {
        const result = claimFlights(userId);
        if (!result.claimed.length) {
          await send(ctx, notice(t("economy.hangar.fly.noneTitle", "Nothing landed yet"), t("economy.hangar.fly.none", "None of your flights have landed. Check `/planes fly status`."), "info"));
          return;
        }
        const ctxView = viewContext();
        const lines = result.claimed.map((c) => {
          const copy = getCopy(c.flight.copyId);
          const view = copy ? copyView(copy, ctxView) : null;
          const extra = [
            c.reward.levelsGained ? t("economy.hangar.fly.levelUp", "level {level}!", { level: c.reward.level }) : "",
            c.reward.bonusCopyId ? t("economy.hangar.fly.bonusCard", "bonus card!") : "",
          ].filter(Boolean);
          return `${HE.flight} ${view ? view.card.name : `#${c.flight.copyId}`}: +${c.reward.parts + c.reward.bonusFallbackParts} Parts, +${c.reward.xp} XP${extra.length ? `, ${extra.join(", ")}` : ""}`;
        });
        lines.push(t("economy.hangar.fly.total", "Total {parts}. Balance {balance}.", { parts: parts(result.parts), balance: parts(getPartsBalance(userId)) }));
        await send(ctx, notice(t("economy.hangar.fly.claimedTitle", "Flights landed"), lines.join("\n"), "success", ctx.ephemeral));
      });
      return;
    }
    if (name === "status") {
      const flights = listActiveFlights(userId);
      const ctxView = viewContext();
      const now = Date.now();
      const lines = flights.map((f) => {
        const copy = getCopy(f.copyId);
        const view = copy ? copyView(copy, ctxView) : null;
        const landed = f.endsAt.getTime() <= now;
        return `${landed ? HE.success : HE.clock} ${view ? view.card.name : `#${f.copyId}`} · ${ROUTES[f.route as RouteKey]?.label ?? f.route} · ${landed ? t("economy.hangar.fly.landed", "landed") : t("economy.hangar.fly.lands", "lands {time}", { time: relTime(f.endsAt) })}`;
      });
      const anyLanded = flights.some((f) => f.endsAt.getTime() <= now);
      const container = summaryContainer(
        `${HE.flight} ${t("economy.hangar.fly.statusTitle", "Flights")}`,
        lines.length ? lines : [t("economy.hangar.fly.empty", "No flights in the air. Start one with `/planes fly start`.")],
        anyLanded ? [row(button(`${HANGAR_PREFIX}fc:${userId}`, t("economy.hangar.fly.claimButton", "Claim landed flights"), ButtonStyle.Primary, HE.flight))] : undefined,
      );
      await send(ctx, v2([container], [], true));
      return;
    }
  }

  // ── /planes trade ... ──
  if (group === "trade") {
    if (!(await need("can_trade"))) return;
    if (name === "offer") {
      const target = i.options.getUser("user", true);
      await guarded(ctx, async () => {
        if (target.bot) throw new HangarError("invalid", "You can't trade with a bot.");
        const give = ["give1", "give2", "give3"].map((n) => copyIdOption(i, n, false)).filter((id): id is number => id !== null);
        const want = ["want1", "want2", "want3"].map((n) => copyIdOption(i, n, false)).filter((id): id is number => id !== null);
        const trade = createTrade({
          fromUserId: userId,
          toUserId: target.id,
          giveCopyIds: give,
          wantCopyIds: want,
          giveCoins: i.options.getNumber("coins") ?? 0,
          wantCoins: i.options.getNumber("ask_coins") ?? 0,
        });
        const message = buildTradeMessage(trade, t);
        // Public, so the other member sees (and gets pinged about) the offer.
        await ctx.interaction.reply({
          components: message.components,
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [], users: [target.id] },
        });
      });
      return;
    }
    if (name === "view") {
      const trades = listTrades(userId, { status: "pending", limit: 10 });
      const containers: TopLevelComponentData[] = [];
      if (!trades.length) {
        containers.push(summaryContainer(`${HE.trade} ${t("economy.hangar.trade.viewTitle", "Your trades")}`, [t("economy.hangar.trade.none", "No open trades.")]));
      }
      for (const trade of trades.slice(0, 5)) containers.push(...buildTradeMessage(trade, t, buildTradeRow(trade, userId, t)).components);
      await send(ctx, v2(containers, [], true));
      return;
    }
  }

  // ── /planes market ... ──
  if (group === "market") {
    if (!(await need("can_market"))) return;
    if (name === "list") {
      await guarded(ctx, async () => {
        const listing = createListing(userId, copyIdOption(i, "copy")!, i.options.getNumber("price", true));
        const copy = getCopy(listing.copyId);
        const view = copy ? copyView(copy, viewContext()) : null;
        await send(
          ctx,
          notice(
            t("economy.hangar.market.listedTitle", "Listed"),
            t("economy.hangar.market.listed", "Listing #{id}: {card} for {price}. You get {net} after the 5% fee. Expires {time}.", {
              id: listing.id,
              card: view ? copyLine(view, t) : `#${listing.copyId}`,
              price: coins(listing.price),
              net: coins(Math.round((listing.price - marketFee(listing.price)) * 100) / 100),
              time: relTime(listing.expiresAt),
            }),
            "success",
            ctx.ephemeral,
          ),
        );
      });
      return;
    }
    if (name === "browse") {
      const page = i.options.getInteger("page") ?? 1;
      const result = browseListings({
        rarity: i.options.getString("rarity"),
        livery: i.options.getString("livery"),
        maxPrice: i.options.getNumber("max_price"),
        sort: (i.options.getString("sort") as "newest" | "price_asc" | "price_desc" | null) ?? "newest",
        page,
        pageSize: 10,
      });
      const ctxView = viewContext();
      const lines = result.rows.map(({ listing, copy }) => {
        const view = copyView(copy, ctxView);
        return `\`#${listing.id}\` ${view ? copyLine(view, t) : copy.id} · ${coins(listing.price)} · <@${listing.sellerId}>`;
      });
      const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
      const buyButtons = result.rows
        .filter((r) => r.listing.sellerId !== userId)
        .slice(0, 5)
        .map((r) => button(`${HANGAR_PREFIX}mb:${userId}:${r.listing.id}`, `#${r.listing.id} (${coinsLabel(r.listing.price)})`, ButtonStyle.Secondary, HE.market));
      const container = summaryContainer(
        `${HE.market} ${t("economy.hangar.market.title", "Market")}`,
        [
          ...(lines.length ? lines : [t("economy.hangar.market.empty", "Nothing for sale matches that.")]),
          `-# ${t("economy.hangar.market.footer", "Page {page} of {pages} · buy with /planes market buy", { page: result.page, pages })}`,
        ],
        buyButtons.length ? [row(...buyButtons)] : undefined,
      );
      await send(ctx, v2([container], [], true));
      return;
    }
    if (name === "buy") {
      await guarded(ctx, async () => {
        const result = buyListing(userId, i.options.getInteger("listing", true));
        const copy = getCopy(result.listing.copyId);
        const view = copy ? copyView(copy, viewContext()) : null;
        await send(
          ctx,
          notice(
            t("economy.hangar.market.boughtTitle", "Bought"),
            t("economy.hangar.market.bought", "You bought {card} for {price}. Balance {balance}.", {
              card: view ? copyLine(view, t) : `#${result.listing.copyId}`,
              price: coins(result.price),
              balance: coins(result.buyerBalance),
            }),
            "success",
            ctx.ephemeral,
          ),
        );
      });
      return;
    }
    if (name === "cancel") {
      await guarded(ctx, async () => {
        const listing = cancelListing(userId, Number(i.options.getString("listing", true)));
        await send(ctx, notice(t("economy.hangar.market.cancelledTitle", "Listing cancelled"), t("economy.hangar.market.cancelled", "Listing #{id} is off the market.", { id: listing.id }), "success", true));
      });
      return;
    }
  }
}

/** Opens a pack and builds the reveal (renders + summary). Shared with the pack list buttons. */
export async function packRevealMessage(userId: string, guildId: string, packKey: string, t: Translator): Promise<V2Message> {
  const result = openPack(userId, guildId, packKey);
  const { gallery, files } = await renderGallery(result.copies.map((c) => c.copy));
  const ctx = viewContext();
  const lines = result.copies.map((c) => {
    const view = copyView(c.copy, ctx);
    return view ? copyLine(view, t) : `#${c.copy.id}`;
  });
  lines.push(
    t("economy.hangar.pack.summary", "{pack} · cost {cost} · balance {balance}", {
      pack: result.pack.name,
      cost: coins(result.cost),
      balance: coins(result.balance),
    }),
  );
  if (result.pityCount !== null && result.pack.pityAfter && result.pack.pityRarity) {
    lines.push(
      `-# ${t("economy.hangar.pack.pityProgress", "{rarity} guaranteed within {left} more cards", {
        rarity: rarityLabel(result.pack.pityRarity, t),
        left: Math.max(1, result.pack.pityAfter - result.pityCount),
      })}`,
    );
  }
  const sets = newSetsLine(result.newlyCompletedSets, t);
  if (sets) lines.push(sets);
  const capacity = hangarCapacity(userId);
  lines.push(`-# ${t("economy.hangar.capacity", "Hangar {used}/{slots}", { used: capacity.used, slots: capacity.slots })}`);
  const container = summaryContainer(`${HE.pack} ${result.pack.name}`, lines);
  return v2(gallery ? [gallery, container] : [container], files);
}

export const hangarCommand: SlashCommandDefinition = {
  plugin: "economy",
  data,
  execute,
};
