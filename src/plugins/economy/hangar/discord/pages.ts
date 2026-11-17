import { ButtonStyle, type TopLevelComponentData } from "discord.js";
import { baseEmbed } from "../../../../core/embeds.js";
import type { Translator } from "../../../../i18n/index.js";
import { HANGAR_MAX_SLOTS, HANGAR_SLOT_STEP, HANGAR_SLOT_STEP_PRICE } from "../constants.js";
import { getCopies, getCopy, hangarCapacity } from "../copies.js";
import { boardingStatus } from "../packs.js";
import { getCoinBalance, getPartsBalance } from "../ledger.js";
import { pilotRankView } from "../score.js";
import { hangarCollection } from "../service.js";
import { getUserState } from "../state.js";
import type { TradeWithItems } from "../trades.js";
import { copyView, viewContext } from "../view.js";
import { HE } from "./emojis.js";
import { HANGAR_PREFIX, button, coins, coinsLabel, copyLine, parts, relTime, renderGallery, row, statsText, v2, type V2Message } from "./views.js";

function headerLines(targetId: string, t: Translator, own: boolean): string[] {
  const state = getUserState(targetId);
  const fleet = state?.fleetValue ?? 0;
  const rank = pilotRankView(fleet);
  const capacity = hangarCapacity(targetId);
  const lines = [
    `${HE.rank} ${t(`economy.hangar.rank.${rank.key}`, rank.label)} · ${t("economy.hangar.fleetValue", "Fleet Value")} \`${fleet.toLocaleString("en-US")}\``,
    `${HE.hangar} ${t("economy.hangar.capacity", "Hangar {used}/{slots}", { used: capacity.used, slots: capacity.slots })}`,
  ];
  if (own) {
    const boarding = boardingStatus(targetId);
    lines.push(`${parts(getPartsBalance(targetId))} · ${coins(getCoinBalance(targetId))}`);
    lines.push(
      boarding.available || !boarding.nextAt
        ? `${HE.boarding} ${t("economy.hangar.boarding.ready", "Boarding pass ready: /planes boarding")}`
        : `${HE.boarding} ${t("economy.hangar.boarding.next", "Next boarding pass {time}", { time: relTime(boarding.nextAt) })}`,
    );
  }
  return lines;
}

/**
 * One page of the hangar browser: the copy's rendered face, a summary of the hangar, and paging
 * buttons. The owner also gets Salvage and Expand.
 */
export async function buildHangarPage(opts: { viewerId: string; targetId: string; targetName: string; index: number; t: Translator }): Promise<V2Message> {
  const { viewerId, targetId, t } = opts;
  const own = viewerId === targetId;
  const first = hangarCollection(targetId, { sort: "rarity", page: 1, pageSize: 1 });
  const total = first.total;
  const title = `${HE.hangar} ${t("economy.inventory.title", "{username}'s hangar", { username: opts.targetName })}`;
  if (total === 0) {
    const container = baseEmbed()
      .setTitle(title)
      .setDescription(
        [
          ...headerLines(targetId, t, own),
          own
            ? t("economy.hangar.emptyOwn", "No cards yet. Claim a free card with `/planes boarding` or open a pack with `/planes pack open`.")
            : t("economy.hangar.emptyOther", "No cards yet."),
        ].join("\n"),
      )
      .toContainerComponent();
    return v2([container]);
  }
  const index = ((opts.index % total) + total) % total;
  const pageResult = index === 0 ? first : hangarCollection(targetId, { sort: "rarity", page: index + 1, pageSize: 1 });
  const view = pageResult.copies[0]!;
  const copy = getCopy(view.id)!;
  const { gallery, files } = await renderGallery([copy]);
  const prev = (index - 1 + total) % total;
  const next = (index + 1) % total;
  const base = `${HANGAR_PREFIX}hv:${viewerId}:${targetId}`;
  const navRow = [
    button(`${base}:p:${prev}`, t("economy.card.backButton", "Back"), ButtonStyle.Secondary, HE.left, total < 2),
    button(`${base}:n:${next}`, t("economy.card.nextButton", "Next"), ButtonStyle.Secondary, HE.right, total < 2),
  ];
  if (own) {
    navRow.push(
      button(`${HANGAR_PREFIX}sv:${viewerId}:${view.id}`, t("economy.hangar.salvageButton", "Salvage ({parts} Parts)", { parts: view.salvageValue.toLocaleString("en-US") }), ButtonStyle.Danger, HE.salvage, Boolean(view.locked)),
    );
    const capacity = hangarCapacity(targetId);
    if (capacity.slots < HANGAR_MAX_SLOTS) {
      navRow.push(
        button(
          `${HANGAR_PREFIX}ex:${viewerId}`,
          t("economy.hangar.expandButton", "+{slots} slots ({cost})", { slots: HANGAR_SLOT_STEP, cost: coinsLabel(HANGAR_SLOT_STEP_PRICE) }),
          ButtonStyle.Secondary,
          HE.hangar,
        ),
      );
    }
  }
  const container = baseEmbed()
    .setTitle(title)
    .setDescription(
      [
        ...headerLines(targetId, t, own),
        "",
        copyLine(view, t),
        statsText(view, t),
        view.locked ? `${HE.locked} ${t("economy.hangar.lockedNote", "Busy: {reason}", { reason: view.locked.reason })}` : "",
      ]
        .filter((l) => l !== null)
        .join("\n"),
    )
    .setFooter({ text: t("economy.card.pageFooter", "Card {index} of {total}", { index: index + 1, total }) })
    .toContainerComponent([row(...navRow)]);
  return v2(gallery ? [gallery, container] : [container], files);
}

/** The trade summary (both sides, coins, expiry) with the buttons the viewer may use. */
export function buildTradeMessage(trade: TradeWithItems, t: Translator, buttons?: ReturnType<typeof row>): { components: TopLevelComponentData[] } {
  const ctx = viewContext();
  const copies = new Map(getCopies([...trade.fromCopyIds, ...trade.toCopyIds]).map((c) => [c.id, c]));
  const side = (ids: number[], coinAmount: number) => {
    const lines = ids.map((id) => {
      const copy = copies.get(id);
      const view = copy ? copyView(copy, ctx) : null;
      return view ? `- ${copyLine(view, t)}` : `- ${t("economy.hangar.trade.gone", "a card that no longer exists")}`;
    });
    if (coinAmount > 0) lines.push(`- ${coins(coinAmount)}`);
    return lines.length ? lines.join("\n") : `- ${t("economy.hangar.trade.nothing", "nothing")}`;
  };
  const description = [
    t("economy.hangar.trade.header", "<@{from}> offers <@{to}> a trade (#{id}).", { from: trade.fromUserId, to: trade.toUserId, id: trade.id }),
    `**${t("economy.hangar.trade.gives", "They give")}**\n${side(trade.fromCopyIds, trade.fromCoins)}`,
    `**${t("economy.hangar.trade.asks", "They ask for")}**\n${side(trade.toCopyIds, trade.toCoins)}`,
    trade.status === "pending"
      ? `-# ${t("economy.hangar.trade.expires", "Expires {time}", { time: relTime(trade.expiresAt) })}`
      : `-# ${t("economy.hangar.trade.status", "Status: {status}", { status: trade.status })}`,
  ].join("\n\n");
  const actions = buttons ?? (trade.status === "pending" ? buildTradeRow(trade, null, t) : undefined);
  return { components: [baseEmbed().setTitle(`${HE.trade} ${t("economy.hangar.trade.title", "Trade offer")}`).setDescription(description).toContainerComponent(actions ? [actions] : undefined)] };
}

/** Accept/Decline/Counter for the recipient, Cancel for the sender (or all four on a public post). */
export function buildTradeRow(trade: TradeWithItems, viewerId: string | null, t: Translator): ReturnType<typeof row> | undefined {
  if (trade.status !== "pending") return undefined;
  const id = trade.id;
  const recipient = viewerId === null || viewerId === trade.toUserId;
  const sender = viewerId === null || viewerId === trade.fromUserId;
  const buttons = [];
  if (recipient) {
    buttons.push(button(`${HANGAR_PREFIX}tra:${id}`, t("economy.hangar.trade.accept", "Accept"), ButtonStyle.Success, HE.success));
    buttons.push(button(`${HANGAR_PREFIX}trd:${id}`, t("economy.hangar.trade.decline", "Decline"), ButtonStyle.Danger, HE.error));
    buttons.push(button(`${HANGAR_PREFIX}tro:${id}`, t("economy.hangar.trade.counter", "Counter"), ButtonStyle.Secondary, HE.trade));
  }
  if (sender) buttons.push(button(`${HANGAR_PREFIX}trc:${id}`, t("economy.hangar.trade.cancel", "Cancel"), ButtonStyle.Secondary));
  return buttons.length ? row(...buttons) : undefined;
}
