import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild } from "discord.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getGuildCasesDashboardUrl, getGuildMemberHubUrl, getIdentityCardUrl } from "../../../core/docsUrl.js";
import { getDb } from "../../../db/client.js";
import { appeals, modCases } from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { queryTickets, type TicketRecord } from "./tickets.js";

const log = getLogger("tickets");

/**
 * The staff-only "Member context" summary on a ticket: what this server already knows about the
 * person who opened it (cases, appeals, Passport, past tickets), so staff don't have to go digging.
 */

/** Case types that undo another case, or are only staff notes: not counted as infractions. */
const NON_INFRACTION_TYPES = new Set(["note", "unmute", "unban"]);

export type MemberContextCase = { id: number; type: string; active: boolean; overturned: boolean; createdAt: Date };

export type MemberContextData = {
  userId: string;
  /** Cases on file for this member in this server, newest first. */
  cases: MemberContextCase[];
  /** Their open appeal (pending or waiting on more info), if any. */
  openAppeal: { id: number; status: string; caseId: number | null } | null;
  /** "off" when Passport isn't enabled on this server. */
  passport: { state: "verified"; verifiedAt: Date } | { state: "pending" } | { state: "unverified" } | { state: "off" };
  /** Their other tickets in this server (the current one left out), newest first. */
  previousTickets: Array<{ number: number; status: string; createdAt: Date }>;
  /** True when the previous-ticket list hit its fetch limit, so the count is "at least". */
  previousTicketsCapped?: boolean;
};

export type MemberContextSummary = {
  activeCases: number;
  totalCases: number;
  overturnedCases: number;
  notes: number;
  lines: string[];
};

const ts = (date: Date, style: "d" | "R" = "R") => `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;

/** Pure: turns the gathered data into counts and the lines shown to staff. */
export function buildMemberContextSummary(data: MemberContextData): MemberContextSummary {
  const infractions = data.cases.filter((c) => !NON_INFRACTION_TYPES.has(c.type));
  const counted = infractions.filter((c) => !c.overturned);
  const overturnedCases = infractions.length - counted.length;
  const activeCases = counted.filter((c) => c.active).length;
  const notes = data.cases.filter((c) => c.type === "note").length;

  const lines: string[] = [`Member: <@${data.userId}> (\`${data.userId}\`)`];

  if (counted.length === 0) {
    lines.push("Cases: **none** on record");
  } else {
    const latest = counted[0]!;
    lines.push(
      `Cases: **${activeCases}** active, **${counted.length}** total (latest: ${latest.type} #${latest.id}, ${ts(latest.createdAt)})`,
    );
  }
  if (overturnedCases > 0) {
    lines.push(`Overturned on appeal: **${overturnedCases}** (not counted above)`);
  }
  if (notes > 0) lines.push(`Staff notes: **${notes}**`);

  if (data.openAppeal) {
    const status = data.openAppeal.status === "needs_info" ? "waiting on more info" : "pending review";
    lines.push(
      `Open appeal: **#${data.openAppeal.id}**, ${status}${data.openAppeal.caseId ? ` (case #${data.openAppeal.caseId})` : ""}`,
    );
  } else {
    lines.push("Open appeal: none");
  }

  switch (data.passport.state) {
    case "verified":
      lines.push(`Passport: **verified** ${ts(data.passport.verifiedAt)}`);
      break;
    case "pending":
      lines.push("Passport: **not verified yet** (waiting to verify)");
      break;
    case "unverified":
      lines.push("Passport: **not verified**");
      break;
    case "off":
      lines.push("Passport: off in this server");
      break;
  }

  const past = data.previousTickets;
  if (past.length === 0) {
    lines.push("Previous tickets: none, this is their first");
  } else {
    const open = past.filter((t) => t.status !== "closed").length;
    const count = `${past.length}${data.previousTicketsCapped ? "+" : ""}`;
    lines.push(
      `Previous tickets: **${count}**${open ? ` (${open} still open)` : ""}, last opened ${ts(past[0]!.createdAt)}`,
    );
  }

  return { activeCases, totalCases: counted.length, overturnedCases, notes, lines };
}

/** Link buttons under the summary: identity card, their cases, and the Member 360 hub. */
export function memberContextLinkRow(guildId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  const casesUrl = getGuildCasesDashboardUrl(guildId);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Identity card")
      .setStyle(ButtonStyle.Link)
      .setURL(getIdentityCardUrl(guildId, userId))
      .setEmoji("<:icons_id:1544417556868104274>"),
    new ButtonBuilder()
      .setLabel("Cases")
      .setStyle(ButtonStyle.Link)
      .setURL(`${casesUrl}&target=${userId}`)
      .setEmoji("<:icons_user_mod:1544418270030074030>"),
    new ButtonBuilder()
      .setLabel("Member 360")
      .setStyle(ButtonStyle.Link)
      .setURL(getGuildMemberHubUrl(guildId, userId))
      .setEmoji("<:icons_Person:1544417372260278353>"),
  );
}

const PREVIOUS_TICKET_LIMIT = 50;

/** Reads everything the summary needs. Each part fails soft: a broken source never blocks the rest. */
export async function gatherMemberContext(
  guild: Guild,
  guildConfig: GuildConfig,
  userId: string,
  currentTicketId: number,
): Promise<MemberContextData> {
  const db = getDb();

  let cases: MemberContextCase[] = [];
  try {
    const rows = db
      .select({ id: modCases.id, type: modCases.type, active: modCases.active, createdAt: modCases.createdAt })
      .from(modCases)
      .where(and(eq(modCases.guildId, guild.id), eq(modCases.userId, userId)))
      .orderBy(desc(modCases.createdAt))
      .limit(500)
      .all();
    // Cases an approved appeal reversed (appeals.reversed), batched in one query.
    const overturned = new Set<number>();
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const reversed = db
        .select({ caseId: appeals.caseId })
        .from(appeals)
        .where(and(eq(appeals.guildId, guild.id), eq(appeals.reversed, true), inArray(appeals.caseId, ids)))
        .all();
      for (const r of reversed) if (r.caseId != null) overturned.add(r.caseId);
    }
    cases = rows.map((r) => ({ ...r, active: Boolean(r.active), overturned: overturned.has(r.id) }));
  } catch (error) {
    log.warn(`Member context: couldn't read cases for ${userId} in ${guild.id}:`, error);
  }

  let openAppeal: MemberContextData["openAppeal"] = null;
  try {
    const row = db
      .select({ id: appeals.id, status: appeals.status, caseId: appeals.caseId })
      .from(appeals)
      .where(and(eq(appeals.guildId, guild.id), eq(appeals.userId, userId), inArray(appeals.status, ["pending", "needs_info"])))
      .orderBy(desc(appeals.id))
      .limit(1)
      .get();
    if (row) openAppeal = { id: row.id, status: row.status, caseId: row.caseId ?? null };
  } catch (error) {
    log.warn(`Member context: couldn't read appeals for ${userId} in ${guild.id}:`, error);
  }

  let passport: MemberContextData["passport"] = { state: "off" };
  // Passport is opt-in (off by default), so only an explicit enable counts.
  if (guildConfig.plugins.passport?.enabled === true) {
    try {
      const store = await import("../../passport/functions/store.js");
      const verified = await store.getPassportVerification(guild.id, userId);
      if (verified) {
        passport = { state: "verified", verifiedAt: verified.verifiedAt };
      } else {
        const pending = await store.getPassportPending(guild.id, userId);
        passport = pending ? { state: "pending" } : { state: "unverified" };
      }
    } catch (error) {
      log.warn(`Member context: couldn't read Passport for ${userId} in ${guild.id}:`, error);
    }
  }

  let previousTickets: MemberContextData["previousTickets"] = [];
  let previousTicketsCapped = false;
  try {
    const { tickets } = await queryTickets(guild.id, { openerId: userId, limit: PREVIOUS_TICKET_LIMIT + 1 });
    const others = (tickets as TicketRecord[]).filter((t) => t.id !== currentTicketId);
    previousTicketsCapped = others.length > PREVIOUS_TICKET_LIMIT;
    previousTickets = others
      .slice(0, PREVIOUS_TICKET_LIMIT)
      .map((t) => ({ number: t.number, status: t.status, createdAt: t.createdAt }));
  } catch (error) {
    log.warn(`Member context: couldn't read tickets for ${userId} in ${guild.id}:`, error);
  }

  return { userId, cases, openAppeal, passport, previousTickets, previousTicketsCapped };
}
