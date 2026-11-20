/**
 * The giveaway post and its follow-ups, as Components V2: the dashboard-designed card (title,
 * description, thumbnail, image, fields, footer, colour) with the live facts underneath (prize,
 * countdown, entry count, winners, host, sponsor, requirements) and the Enter button. Posts made
 * before 0150 are classic embeds (`messageFormat: "embed"`) and keep being edited with embeds.ts.
 */
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type APIButtonComponent,
  type BaseMessageOptions,
  type ComponentInContainerData,
  type Guild,
  type GuildTextBasedChannel,
  type TopLevelComponentData,
} from "discord.js";
import { buildEmbed } from "../../persist/functions/messageBuilder.js";
import { parseComponentEmoji } from "../../../core/emoji.js";
import { buildGiveawayClaimCustomId, buildGiveawayEnterCustomId } from "./customIds.js";
import {
  buildClaimComponents,
  buildGiveawayCancelledEmbed,
  buildGiveawayComponents,
  buildGiveawayEmbed,
  buildGiveawayEndedEmbed,
} from "./embeds.js";
import type { Giveaway, GiveawayDraw, GiveawayWinner } from "./store.js";

export const GIVEAWAY_EMOJI = {
  gift: "<:icons_gift:1544417552627802212>",
  clock: "<:icons_clock:1544417185336664114>",
  trophy: "<:icons_trophy:1544418249721126922>",
  people: "<:icons_people:1544417371215626262>",
  host: "<:icons_Person:1544417372260278353>",
  star: "<:icons_star:1544417435636080741>",
  rules: "<:icons_rules:1544417580565921832>",
  loop: "<:icons_loop:1544417722950098954>",
  pause: "<:icons_pause:1544417366744760380>",
  tada: "<:icons_tada:1544417975472492594>",
  summary: "<:icons_summary:1544418222831571044>",
  fingerprint: "<:icons_fingerprint:1544418020682899537>",
  check: "<:icons_Correct:1544417199798886530>",
  cross: "<:icons_Wrong:1544417460638457937>",
  calendar: "<:icons_calendar1:1544417163019026594>",
} as const;

const DEFAULT_COLOR = 0x5662f5;
/** Components V2 text displays share a 4000 character budget per message. */
const TEXT_BUDGET = 3800;

export type GiveawayPayload = BaseMessageOptions & { flags?: number };

function ts(date: Date, style: "R" | "f" | "F" | "D" = "R"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function buttonStyle(style: string): ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger {
  switch (style) {
    case "secondary":
      return ButtonStyle.Secondary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Primary;
  }
}

/** One line per entry requirement, for the post and the info command. */
export function requirementLines(giveaway: Giveaway): string[] {
  const lines: string[] = [];
  if (giveaway.requireRoleIds.length) {
    const roles = giveaway.requireRoleIds.map((id) => `<@&${id}>`).join(", ");
    lines.push(giveaway.requireRoleIds.length === 1 ? `Have ${roles}` : `${giveaway.requireRoleMode === "all" ? "All of" : "One of"} ${roles}`);
  }
  if (giveaway.blacklistRoleIds.length) lines.push(`Not ${giveaway.blacklistRoleIds.map((id) => `<@&${id}>`).join(", ")}`);
  if (giveaway.minAccountAgeDays > 0) lines.push(`Account at least ${plural(giveaway.minAccountAgeDays, "day", "days")} old`);
  if (giveaway.minJoinAgeDays > 0) lines.push(`In the server for ${plural(giveaway.minJoinAgeDays, "day", "days")}`);
  if (giveaway.minMessages > 0) lines.push(`${plural(giveaway.minMessages, "message", "messages")} sent here`);
  if (giveaway.requirePassport) lines.push("Verified with Passport");
  return lines;
}

/** "2x for @Booster" style lines for bonus entries. */
export function bonusLines(giveaway: Giveaway): string[] {
  const lines = giveaway.bonusRoleWeights
    .filter((b) => b.roleId && Number.isFinite(b.weight) && b.weight > 1)
    .map((b) => `<@&${b.roleId}> get ${plural(b.weight, "entry", "entries")}`);
  if (giveaway.boosterBonusWeight > 0) lines.push(`Server boosters get ${plural(giveaway.boosterBonusWeight, "extra entry", "extra entries")}`);
  return lines;
}

type Card = { title: string; description: string; thumbnail: string | null; image: string | null; footer: string; fields: string[]; color: number };

/** The dashboard-designed part, through the same template/icon rendering as Persist embeds. */
function renderCard(giveaway: Giveaway, guild: Guild, extra: Record<string, string>): Card {
  const embed = buildEmbed(
    { ...giveaway.embedConfig, enabled: true },
    { client: guild.client, guild, channel: undefined as unknown as GuildTextBasedChannel, extra },
  );
  const data = embed?.data ?? {};
  return {
    title: (data.title ?? "").trim() || (giveaway.title || giveaway.prize).trim(),
    description: (data.description ?? "").trim(),
    thumbnail: data.thumbnail?.url ?? null,
    image: data.image?.url ?? null,
    footer: (data.footer?.text ?? "").trim(),
    fields: (data.fields ?? []).map((f) => `**${f.name}**\n${f.value}`),
    color: typeof data.color === "number" ? data.color : (giveaway.embedConfig.color ?? DEFAULT_COLOR),
  };
}

function templateVars(giveaway: Giveaway): Record<string, string> {
  return {
    prize: giveaway.prize,
    winners: String(giveaway.winnerCount),
    ends: ts(giveaway.endsAt),
    host: giveaway.hostId ? `<@${giveaway.hostId}>` : "",
    sponsor: giveaway.sponsor,
  };
}

function headerBlock(card: Card, kicker: string | null): ComponentInContainerData {
  const text = [kicker ? `-# ${kicker}` : null, `### ${card.title.slice(0, 256)}`, card.description || null].filter(Boolean).join("\n");
  const content = text.slice(0, 2000);
  if (card.thumbnail) {
    return {
      type: ComponentType.Section,
      components: [{ type: ComponentType.TextDisplay, content }],
      accessory: { type: ComponentType.Thumbnail, media: { url: card.thumbnail } },
    };
  }
  return { type: ComponentType.TextDisplay, content };
}

function separator(divider = true): ComponentInContainerData {
  return { type: ComponentType.Separator, divider, spacing: SeparatorSpacingSize.Small };
}

function text(content: string): ComponentInContainerData {
  return { type: ComponentType.TextDisplay, content: content.slice(0, 3000) };
}

function hostLines(giveaway: Giveaway): string[] {
  const lines: string[] = [];
  if (giveaway.hostId) lines.push(`${GIVEAWAY_EMOJI.host} **Hosted by** <@${giveaway.hostId}>`);
  if (giveaway.sponsor.trim()) lines.push(`${GIVEAWAY_EMOJI.star} **Sponsored by** ${giveaway.sponsor.trim().slice(0, 200)}`);
  return lines;
}

function enterButton(giveaway: Giveaway, disabled: boolean): APIButtonComponent {
  const button: APIButtonComponent = {
    type: ComponentType.Button,
    custom_id: buildGiveawayEnterCustomId(giveaway.id),
    style: buttonStyle(giveaway.buttonStyle),
    label: (giveaway.buttonLabel.trim() || "Enter").slice(0, 80),
    disabled,
  };
  const emoji = parseComponentEmoji(giveaway.buttonEmoji || GIVEAWAY_EMOJI.gift);
  if (emoji) (button as { emoji?: unknown }).emoji = typeof emoji === "string" ? { name: emoji } : emoji;
  return button;
}

function claimButton(giveaway: Giveaway): APIButtonComponent {
  const emoji = parseComponentEmoji(GIVEAWAY_EMOJI.trophy);
  return {
    type: ComponentType.Button,
    custom_id: buildGiveawayClaimCustomId(giveaway.id, 0),
    style: ButtonStyle.Success,
    label: "Claim prize",
    ...(emoji && typeof emoji !== "string" ? { emoji } : {}),
  } as APIButtonComponent;
}

function row(...buttons: APIButtonComponent[]): ComponentInContainerData {
  return { type: ComponentType.ActionRow, components: buttons } as unknown as ComponentInContainerData;
}

function fitDescription(card: Card, used: number): Card {
  const room = Math.max(0, TEXT_BUDGET - used);
  return card.description.length > room ? { ...card, description: `${card.description.slice(0, Math.max(0, room - 3))}...` } : card;
}

/** The post while the giveaway runs (or is paused). */
export function buildLiveV2(giveaway: Giveaway, entryCount: number, guild: Guild, options: { ping?: boolean } = {}): GiveawayPayload {
  const paused = giveaway.status === "paused";
  const facts: string[] = [`${GIVEAWAY_EMOJI.gift} **Prize:** ${giveaway.prize.slice(0, 256)}`];
  facts.push(
    paused
      ? `${GIVEAWAY_EMOJI.pause} **Paused.** Entries and the countdown are on hold until staff resume it.`
      : `${GIVEAWAY_EMOJI.clock} **Ends** ${ts(giveaway.endsAt)} (${ts(giveaway.endsAt, "f")})`,
  );
  facts.push(`${GIVEAWAY_EMOJI.trophy} **Winners:** ${giveaway.winnerCount.toLocaleString("en-US")}`);
  facts.push(`${GIVEAWAY_EMOJI.people} **Entries:** ${Math.max(0, entryCount || 0).toLocaleString("en-US")}`);
  facts.push(...hostLines(giveaway));
  if (giveaway.recurrence !== "none") facts.push(`${GIVEAWAY_EMOJI.loop} Runs again ${giveaway.recurrence === "daily" ? "every day" : "every week"}`);

  const reqs = requirementLines(giveaway);
  const bonus = bonusLines(giveaway);
  const howTo =
    giveaway.entryMethod === "reaction"
      ? `-# React with ${giveaway.reactionEmoji} to enter. Remove your reaction to leave.`
      : "-# Press the button to enter. Changed your mind? Press it again to leave.";

  let card = renderCard(giveaway, guild, templateVars(giveaway));
  const extras = [
    reqs.length ? `${GIVEAWAY_EMOJI.rules} **To enter**\n${reqs.map((l) => `- ${l}`).join("\n")}` : "",
    bonus.length ? `${GIVEAWAY_EMOJI.star} **Bonus entries**\n${bonus.map((l) => `- ${l}`).join("\n")}` : "",
  ].filter(Boolean);
  const used = facts.join("\n").length + extras.join("\n").length + card.fields.join("\n").length + card.footer.length + card.title.length + 200;
  card = fitDescription(card, used);

  const children: ComponentInContainerData[] = [headerBlock(card, null)];
  if (card.fields.length) children.push(text(card.fields.join("\n\n")));
  children.push(separator());
  children.push(text(facts.join("\n")));
  if (extras.length) children.push(text(extras.join("\n\n")));
  if (card.image) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: card.image } }] });
  children.push(text([howTo, card.footer ? `-# ${card.footer}` : ""].filter(Boolean).join("\n")));
  if (giveaway.entryMethod === "button") {
    children.push(separator(false));
    children.push(row(enterButton(giveaway, paused)));
  }

  const components: TopLevelComponentData[] = [];
  const ping = options.ping && giveaway.pingRoleId ? `<@&${giveaway.pingRoleId}>` : "";
  if (ping) components.push({ type: ComponentType.TextDisplay, content: ping });
  components.push({ type: ComponentType.Container, accentColor: card.color, components: children });
  return {
    components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], roles: ping && giveaway.pingRoleId ? [giveaway.pingRoleId] : [] },
  };
}

export type EndedSummary = {
  winners: GiveawayWinner[];
  entrants: number;
  totalWeight: number;
  draw: GiveawayDraw | null;
};

function winnerLabel(winner: GiveawayWinner): string {
  return winner.status === "claimed" ? `<@${winner.userId}> ${GIVEAWAY_EMOJI.check}` : `<@${winner.userId}>`;
}

/** The original post once the giveaway has ended: winners, a short summary and the draw seed. */
export function buildEndedV2(giveaway: Giveaway, summary: EndedSummary, guild: Guild): GiveawayPayload {
  const current = summary.winners.filter((w) => w.status === "won" || w.status === "claimed");
  const unclaimed = current.some((w) => w.status === "won") && giveaway.claimWindowMinutes > 0;
  const card = renderCard(giveaway, guild, templateVars(giveaway));
  const endedAt = giveaway.endedAt ?? new Date();

  const lines = [`${GIVEAWAY_EMOJI.gift} **Prize:** ${giveaway.prize.slice(0, 256)}`];
  lines.push(
    current.length
      ? `${GIVEAWAY_EMOJI.trophy} **${current.length === 1 ? "Winner" : "Winners"}:** ${current.map(winnerLabel).join(", ")}`.slice(0, 1800)
      : `${GIVEAWAY_EMOJI.trophy} **Winners:** Nobody entered who could win.`,
  );
  lines.push(
    `${GIVEAWAY_EMOJI.people} **Entries:** ${plural(summary.entrants, "member", "members")}` +
      (summary.totalWeight > summary.entrants ? `, ${plural(Math.round(summary.totalWeight * 100) / 100, "entry", "entries")} with bonuses` : ""),
  );
  lines.push(...hostLines(giveaway));
  if (unclaimed) {
    const first = current.find((w) => w.status === "won");
    if (first) {
      const deadline = new Date(first.selectedAt.getTime() + giveaway.claimWindowMinutes * 60_000);
      lines.push(`${GIVEAWAY_EMOJI.clock} Winners have until ${ts(deadline)} to claim, or the prize is drawn again.`);
    }
  }

  const children: ComponentInContainerData[] = [headerBlock({ ...card, description: "" }, `Ended ${ts(endedAt)}`), separator(), text(lines.join("\n"))];
  if (card.image) children.push({ type: ComponentType.MediaGallery, items: [{ media: { url: card.image } }] });
  const seed = summary.draw?.seed;
  children.push(
    text(
      [
        seed ? `-# ${GIVEAWAY_EMOJI.fingerprint} Verifiable draw. Seed \`${seed.slice(0, 16)}\`, pool \`${(summary.draw?.poolHash ?? "").slice(0, 12)}\`` : "",
        card.footer ? `-# ${card.footer}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "-# Giveaway ended",
    ),
  );
  if (unclaimed) {
    children.push(separator(false));
    children.push(row(claimButton(giveaway)));
  }
  return {
    components: [{ type: ComponentType.Container, accentColor: card.color, components: children }],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

/** Posted under the giveaway when winners are drawn (and again after a reroll). Pings the winners. */
export function buildAnnouncementV2(
  giveaway: Giveaway,
  newWinnerIds: string[],
  kind: "draw" | "reroll" | "auto_reroll",
  messageUrl: string | null,
): GiveawayPayload {
  const mentions = newWinnerIds.map((id) => `<@${id}>`).join(", ");
  const heading =
    kind === "draw" ? `### ${GIVEAWAY_EMOJI.tada} Congratulations!` : `### ${GIVEAWAY_EMOJI.tada} ${newWinnerIds.length === 1 ? "New winner" : "New winners"}`;
  const body = newWinnerIds.length
    ? `${mentions} won **${giveaway.prize.slice(0, 256)}**!`
    : kind === "draw"
      ? `Nobody who entered could win **${giveaway.prize.slice(0, 256)}**, so there's no winner this time.`
      : "Nobody else was left to draw from, so there's no new winner.";
  const lines = [heading, body];
  if (kind === "auto_reroll" && newWinnerIds.length) lines.push("The last winner didn't claim in time.");
  if (newWinnerIds.length && giveaway.claimWindowMinutes > 0) {
    const deadline = new Date(Date.now() + giveaway.claimWindowMinutes * 60_000);
    lines.push(`-# Claim it ${ts(deadline)} with the button below, or it goes to someone else.`);
  }
  const children: ComponentInContainerData[] = [text(lines.join("\n"))];
  const buttons: APIButtonComponent[] = [];
  if (newWinnerIds.length && giveaway.claimWindowMinutes > 0) buttons.push(claimButton(giveaway));
  if (messageUrl) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, label: "View giveaway", url: messageUrl });
  if (buttons.length) children.push(row(...buttons));
  return {
    components: [{ type: ComponentType.Container, accentColor: giveaway.embedConfig.color ?? DEFAULT_COLOR, components: children }],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: newWinnerIds },
  };
}

export function buildCancelledV2(giveaway: Giveaway, guild: Guild): GiveawayPayload {
  const card = renderCard(giveaway, guild, templateVars(giveaway));
  return {
    components: [
      {
        type: ComponentType.Container,
        accentColor: card.color,
        components: [
          headerBlock({ ...card, description: "" }, "Cancelled"),
          separator(),
          text(`${GIVEAWAY_EMOJI.gift} **Prize:** ${giveaway.prize.slice(0, 256)}\n${GIVEAWAY_EMOJI.cross} This giveaway was cancelled, so nobody won.`),
        ],
      },
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

// -- Format switch (Components V2 for new posts, embeds for posts made before 0150) ---------------

export function livePayload(giveaway: Giveaway, entryCount: number, guild: Guild, options: { ping?: boolean } = {}): GiveawayPayload {
  if (giveaway.messageFormat === "v2") return buildLiveV2(giveaway, entryCount, guild, options);
  return { embeds: [buildGiveawayEmbed(giveaway, entryCount, guild)], components: buildGiveawayComponents(giveaway, entryCount), allowedMentions: { parse: [] } };
}

export function endedPayload(giveaway: Giveaway, summary: EndedSummary, guild: Guild): GiveawayPayload {
  if (giveaway.messageFormat === "v2") return buildEndedV2(giveaway, summary, guild);
  const current = summary.winners.filter((w) => w.status === "won" || w.status === "claimed");
  const unclaimed = giveaway.claimWindowMinutes > 0 && current.some((w) => w.status === "won");
  return {
    embeds: [buildGiveawayEndedEmbed(giveaway, current.map((w) => w.userId))],
    components: unclaimed ? buildClaimComponents(giveaway.id, 0) : [],
    allowedMentions: { parse: [] },
  };
}

export function cancelledPayload(giveaway: Giveaway, guild: Guild): GiveawayPayload {
  if (giveaway.messageFormat === "v2") return buildCancelledV2(giveaway, guild);
  return { embeds: [buildGiveawayCancelledEmbed(giveaway)], components: [], allowedMentions: { parse: [] } };
}

/** Edits keep the V2 flag (it can't be removed) and never ping again. */
export function asEdit(payload: GiveawayPayload): GiveawayPayload {
  const v2 = Boolean((payload.flags ?? 0) & MessageFlags.IsComponentsV2);
  return { ...payload, ...(v2 ? { flags: MessageFlags.IsComponentsV2 } : {}), allowedMentions: { parse: [] } };
}

export function messageUrl(giveaway: Pick<Giveaway, "guildId" | "channelId" | "messageId">): string | null {
  return giveaway.messageId ? `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}` : null;
}
