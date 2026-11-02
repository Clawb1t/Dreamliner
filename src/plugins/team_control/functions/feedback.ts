import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Guild } from "discord.js";
import { configManager } from "../../../config/manager.js";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { embedField } from "../../../core/embeds.js";
import { getLogger } from "../../../core/logger.js";
import { neutralizeMentions } from "../../../core/templates.js";
import { HOUR_MS, MAX_COMMENT, TEAM_PREFIX, unix } from "./config.js";
import { loadTeamRuntime } from "./members.js";
import { dmTeamCard, postTeamMessage, teamCard } from "./messages.js";
import { isOnTeam } from "./ranks.js";
import { getTeamMember, insertFeedback, lastDirectFeedback, type FeedbackRow } from "./store.js";

const log = getLogger("team_control");

/** `team:rate:<guildId>:<ticketId>:<score>` on the DM after a ticket closes. */
export const RATE_BUTTON = `${TEAM_PREFIX}rate:`;
/** `team:ratec:<feedbackId>` opens the comment modal; the modal is `team:ratecm:<feedbackId>`. */
export const RATE_COMMENT_BUTTON = `${TEAM_PREFIX}ratec:`;
export const RATE_COMMENT_MODAL = `${TEAM_PREFIX}ratecm:`;

export const STARS = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

export type FeedbackResult = { ok: true; feedback: FeedbackRow } | { ok: false; error: string };

export function cleanComment(comment: string | null | undefined): string | null {
  const trimmed = comment?.trim();
  return trimmed ? neutralizeMentions(trimmed.slice(0, MAX_COMMENT)) : null;
}

/** Logs new feedback (staff see it anonymised, so the log, a manager space, names the rater). */
export async function logFeedback(client: Client, guild: Guild, config: TeamControlConfig, feedback: FeedbackRow): Promise<void> {
  const channelId = config.feedback.log_channel_id;
  if (!channelId) return;
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  await postTeamMessage(
    client,
    guild,
    channelId,
    teamCard(client, guildConfig, "New feedback", `<@${feedback.raterId}> rated <@${feedback.staffId}> **${STARS(feedback.rating)}**${feedback.source === "ticket" ? ` after ticket #${feedback.ticketId}` : ""}.`, {
      fields: feedback.comment ? [embedField("Comment", feedback.comment)] : [],
    }),
  );
}

/** `/team rate`: a member rates a staff member directly. */
export async function rateDirect(
  guild: Guild,
  config: TeamControlConfig,
  raterId: string,
  staffId: string,
  rating: number,
  comment: string | null,
  raterOnTeam: boolean,
): Promise<FeedbackResult> {
  if (!config.feedback.enabled || !config.feedback.direct) return { ok: false, error: "Rating staff directly is turned off on this server." };
  if (raterId === staffId) return { ok: false, error: "You can't rate yourself." };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: "Ratings go from 1 to 5." };
  const staff = await guild.members.fetch(staffId).catch(() => null);
  if (!staff || !isOnTeam(staff, config.ranks)) return { ok: false, error: "You can only rate members of the staff team." };
  if (config.feedback.members_only && raterOnTeam) return { ok: false, error: "Staff can't rate each other here." };
  const last = lastDirectFeedback(guild.id, raterId, staffId);
  const next = last ? last.getTime() + config.feedback.cooldown_hours * HOUR_MS : 0;
  if (next > Date.now()) return { ok: false, error: `You can rate <@${staffId}> again <t:${unix(next)}:R>.` };
  const feedback = insertFeedback({
    guildId: guild.id,
    staffId,
    raterId,
    rating,
    comment: cleanComment(comment),
    source: "direct",
    ticketId: null,
    createdAt: new Date(),
  });
  if (!feedback) return { ok: false, error: "Couldn't save that rating. Try again." };
  await logFeedback(guild.client, guild, config, feedback).catch(() => null);
  return { ok: true, feedback };
}

/**
 * After a ticket closes: DMs the opener a 1-5 rating for the staff member who handled it (who
 * claimed it, else who closed it). The tickets plugin has no rating prompt of its own, so this is
 * the only one, and the score is also stored on the ticket.
 */
export async function sendTicketRatingPrompt(
  client: Client,
  guild: Guild,
  ticket: { id: number; number: number; openerId: string; claimedBy: string | null; closedBy: string | null },
): Promise<void> {
  const runtime = await loadTeamRuntime(guild.id);
  if (!runtime) return;
  const { config, guildConfig } = runtime;
  if (!config.feedback.enabled || !config.feedback.after_ticket) return;
  const staffId = ticket.claimedBy ?? ticket.closedBy;
  if (!staffId || staffId === ticket.openerId) return;
  const staff = await guild.members.fetch(staffId).catch(() => null);
  if (!staff || !isOnTeam(staff, config.ranks)) return;
  const opener = await client.users.fetch(ticket.openerId).catch(() => null);
  if (!opener || opener.bot) return;
  if (config.feedback.members_only) {
    const openerRow = getTeamMember(guild.id, opener.id);
    if (openerRow && openerRow.leftTeamAt === null && openerRow.status !== "terminated") return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    [1, 2, 3, 4, 5].map((score) =>
      new ButtonBuilder()
        .setCustomId(`${RATE_BUTTON}${guild.id}:${ticket.id}:${score}`)
        .setLabel(`${score} ★`)
        .setStyle(score >= 4 ? ButtonStyle.Success : score <= 2 ? ButtonStyle.Danger : ButtonStyle.Secondary),
    ),
  );
  const sent = await dmTeamCard(
    opener,
    teamCard(client, guildConfig, `How did we do in ${guild.name}?`, `Your ticket #${ticket.number} was handled by **${neutralizeMentions(staff.displayName)}**. How would you rate their help?`, {
      thumbnail: staff.displayAvatarURL({ size: 128 }),
      footer: "Your rating is shared with the server's staff managers.",
    }),
    [row],
  );
  if (!sent) log.debug(`Couldn't DM a ticket rating prompt to ${opener.id}`);
}

/** Records a rating from the ticket DM. Null staff = the ticket no longer has anyone to credit. */
export async function recordTicketRating(
  client: Client,
  guildId: string,
  ticketId: number,
  raterId: string,
  score: number,
): Promise<{ ok: true; feedback: FeedbackRow; staffId: string } | { ok: false; error: string }> {
  const runtime = await loadTeamRuntime(guildId);
  if (!runtime || !runtime.config.feedback.enabled) return { ok: false, error: "Feedback isn't being collected on that server anymore." };
  const { getTicket, setRating } = await import("../../tickets/functions/tickets.js");
  const ticket = await getTicket(guildId, ticketId);
  if (!ticket || ticket.openerId !== raterId) return { ok: false, error: "This rating isn't for you." };
  const staffId = ticket.claimedBy ?? ticket.closedBy;
  if (!staffId) return { ok: false, error: "That ticket has no staff member to rate." };
  const feedback = insertFeedback({
    guildId,
    staffId,
    raterId,
    rating: score,
    comment: null,
    source: "ticket",
    ticketId,
    createdAt: new Date(),
  });
  if (!feedback) return { ok: false, error: "You've already rated this ticket. Thanks!" };
  await setRating(guildId, ticketId, score).catch(() => null);
  const guild = client.guilds.cache.get(guildId);
  if (guild) await logFeedback(client, guild, runtime.config, feedback).catch(() => null);
  return { ok: true, feedback, staffId };
}
