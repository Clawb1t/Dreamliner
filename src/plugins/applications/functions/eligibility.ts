import type { GuildMember } from "discord.js";
import type { ApplicationOpening } from "../../../config/schemas/applications.js";
import type { Translator } from "../../../i18n/index.js";
import { FORM_KIND_NOUNS, openingName } from "./config.js";
import { canEditLatest, limitBlocker, type Blocker } from "./formLogic.js";
import { responseHistory, type ApplicationRecord } from "./store.js";

const DAY_MS = 86_400_000;

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** Closed, not set up, or the member doesn't meet the form's role and age requirements. */
export function memberBlocker(member: GuildMember, opening: ApplicationOpening, t: Translator): string | null {
  const name = openingName(opening);
  const application = opening.kind === "application";
  if (!opening.enabled || !opening.accepting) {
    return application
      ? t("applications.closedBody", "Applications for **{opening}** are closed right now.", { opening: name })
      : t("forms.closedBody", "**{form}** isn't taking responses right now.", { form: name });
  }
  if (opening.questions.length === 0 && opening.kind !== "rsvp") {
    return application
      ? t("applications.noFormBody", "This application isn't set up yet. Ask a server admin to add some questions.")
      : t("forms.noQuestionsBody", "This form isn't set up yet. Ask a server admin to add some questions.");
  }

  const roles = member.roles.cache;
  if (opening.blocked_roles.some((id) => roles.has(id))) {
    return application
      ? t("applications.blockedBody", "You can't apply for **{opening}**.", { opening: name })
      : t("forms.blockedBody", "You can't respond to **{form}**.", { form: name });
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
  return null;
}

/** The message for a limit, in the form's own words. */
export function blockerMessage(blocker: Blocker, opening: ApplicationOpening, t: Translator): string {
  const name = openingName(opening);
  const noun = FORM_KIND_NOUNS[opening.kind];
  switch (blocker.kind) {
    case "not_open":
      return t("forms.notOpenBody", "**{form}** opens <t:{at}:R>.", { form: name, at: Math.floor(blocker.at / 1000) });
    case "closed":
      return t("forms.closedAtBody", "**{form}** has closed.", { form: name });
    case "full":
      return t("forms.fullBody", "**{form}** has all the responses it needs.", { form: name });
    case "pending":
      return opening.kind === "application"
        ? t("applications.alreadyPendingBody", "You already have a **{opening}** application waiting for review.", { opening: name })
        : t("forms.pendingBody", "Your {noun} for **{form}** is still waiting for review.", { noun, form: name });
    case "limit":
      return blocker.max === 1
        ? t("forms.onceBody", "You've already responded to **{form}**.", { form: name })
        : t("forms.limitBody", "You've sent the most responses allowed for **{form}** ({max}).", { form: name, max: blocker.max });
    case "cooldown":
      return t("forms.cooldownBody", "You can respond to **{form}** again <t:{at}:R>.", { form: name, at: Math.ceil(blocker.at / 1000) });
    case "already_accepted":
      return t("applications.alreadyAcceptedBody", "You've already been accepted for **{opening}**.", { opening: name });
    case "denied_cooldown":
      return t("applications.cooldownBody", "You can apply for **{opening}** again <t:{at}:R>.", {
        opening: name,
        at: Math.ceil(blocker.at / 1000),
      });
  }
}

export type StartDecision =
  | { ok: true; editing: ApplicationRecord | null }
  | { ok: false; message: string };

/**
 * Whether this member can start the form now: a fresh response, editing their open one (when
 * the form allows edits), or why not. Checked when they press the button and again on submit.
 */
export function startDecision(member: GuildMember, opening: ApplicationOpening, t: Translator): StartDecision {
  const blocked = memberBlocker(member, opening, t);
  if (blocked) return { ok: false, message: blocked };
  const history = responseHistory(member.guild.id, member.id, opening.id);
  if (history.latest && canEditLatest(opening, history.latest)) return { ok: true, editing: history.latest };
  const roles = member.roles.cache;
  const hasAcceptRoles = opening.accept_roles.length > 0 && opening.accept_roles.every((id) => roles.has(id));
  const limit = limitBlocker(opening, history, Date.now(), { hasAcceptRoles });
  if (limit) return { ok: false, message: blockerMessage(limit, opening, t) };
  return { ok: true, editing: null };
}

/** Kept for callers from before Forms: why this member can't apply right now, or null. */
export function applyBlocker(member: GuildMember, opening: ApplicationOpening, t: Translator): string | null {
  const decision = startDecision(member, opening, t);
  return decision.ok ? null : decision.message;
}
