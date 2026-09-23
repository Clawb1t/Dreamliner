import type { GuildMember } from "discord.js";
import type { ApplicationOpening } from "../../../config/schemas/applications.js";
import type { Translator } from "../../../i18n/index.js";
import { openingName } from "./config.js";
import { latestApplication } from "./store.js";

const DAY_MS = 86_400_000;

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** Why this member can't apply right now, or null when they can. */
export function applyBlocker(member: GuildMember, opening: ApplicationOpening, t: Translator): string | null {
  const name = openingName(opening);
  if (!opening.enabled || !opening.accepting) {
    return t("applications.closedBody", "Applications for **{opening}** are closed right now.", { opening: name });
  }
  if (opening.questions.length === 0) {
    return t("applications.noFormBody", "This application isn't set up yet. Ask a server admin to add some questions.");
  }

  const roles = member.roles.cache;
  if (opening.blocked_roles.some((id) => roles.has(id))) {
    return t("applications.blockedBody", "You can't apply for **{opening}**.", { opening: name });
  }
  if (opening.required_roles.length > 0 && !opening.required_roles.some((id) => roles.has(id))) {
    return t("applications.missingRoleBody", "You need one of these roles to apply: {roles}", {
      roles: opening.required_roles.map((id) => `<@&${id}>`).join(", "),
    });
  }

  const now = Date.now();
  if (opening.min_account_age_days > 0 && now - member.user.createdTimestamp < opening.min_account_age_days * DAY_MS) {
    return t("applications.accountTooNewBody", "Your account needs to be at least {days} old to apply.", {
      days: days(opening.min_account_age_days),
    });
  }
  if (opening.min_member_days > 0 && member.joinedTimestamp && now - member.joinedTimestamp < opening.min_member_days * DAY_MS) {
    return t("applications.memberTooNewBody", "You need to have been in this server for {days} to apply.", {
      days: days(opening.min_member_days),
    });
  }

  const latest = latestApplication(member.guild.id, member.id, opening.id);
  if (latest?.status === "pending") {
    return t("applications.alreadyPendingBody", "You already have a **{opening}** application waiting for review.", {
      opening: name,
    });
  }
  if (latest?.status === "accepted" && opening.accept_roles.length > 0 && opening.accept_roles.every((id) => roles.has(id))) {
    return t("applications.alreadyAcceptedBody", "You've already been accepted for **{opening}**.", { opening: name });
  }
  if (latest?.status === "denied" && latest.decidedAt && opening.cooldown_days > 0) {
    const readyAt = latest.decidedAt.getTime() + opening.cooldown_days * DAY_MS;
    if (now < readyAt) {
      return t("applications.cooldownBody", "You can apply for **{opening}** again <t:{at}:R>.", {
        opening: name,
        at: Math.ceil(readyAt / 1000),
      });
    }
  }
  return null;
}
