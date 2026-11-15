import { and, desc, eq } from "drizzle-orm";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getDb } from "../../../db/client.js";
import { applications } from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { neutralizeMentions } from "../../../core/templates.js";

const log = getLogger("team_control");

/** The application that got someone onto the team, for their profile and trial review. */
export type AcceptedApplication = {
  id: number;
  openingName: string;
  reviewerId: string | null;
  submittedAt: Date;
  decidedAt: Date | null;
  /** Jump link to the application's review post in Discord, when it still has one. */
  reviewUrl: string | null;
};

/**
 * The member's most recently accepted application in this server, or null when Applications is
 * off, they never applied, or nothing was accepted. Works with Applications; never throws.
 */
export function acceptedApplicationFor(guildConfig: GuildConfig, guildId: string, userId: string): AcceptedApplication | null {
  if (!pluginEnabled(guildConfig, "applications")) return null;
  try {
    const row = getDb()
      .select()
      .from(applications)
      .where(and(eq(applications.guildId, guildId), eq(applications.userId, userId), eq(applications.status, "accepted")))
      .orderBy(desc(applications.decidedAt), desc(applications.id))
      .limit(1)
      .get();
    if (!row) return null;
    const channelId = row.threadId ?? row.reviewChannelId;
    return {
      id: row.id,
      openingName: row.openingName,
      reviewerId: row.reviewerId,
      submittedAt: row.createdAt,
      decidedAt: row.decidedAt,
      reviewUrl:
        row.reviewChannelId && row.reviewMessageId
          ? `https://discord.com/channels/${guildId}/${row.reviewChannelId}/${row.reviewMessageId}`
          : channelId
            ? `https://discord.com/channels/${guildId}/${channelId}`
            : null,
    };
  } catch (err) {
    log.error("Accepted application lookup failed:", err);
    return null;
  }
}

/** "#12 Moderator, accepted <t:..:D> by @x · [Open]" for staff cards. */
export function acceptedApplicationLine(app: AcceptedApplication): string {
  const when = app.decidedAt ? ` <t:${Math.floor(app.decidedAt.getTime() / 1000)}:D>` : "";
  const by = app.reviewerId ? ` by <@${app.reviewerId}>` : "";
  const link = app.reviewUrl ? ` · [Open](${app.reviewUrl})` : "";
  return `#${app.id} ${neutralizeMentions(app.openingName.slice(0, 80))}, accepted${when}${by}${link}`;
}
