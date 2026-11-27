import {
  zApplicationsConfig,
  type ApplicationOpening,
  type ApplicationsConfig,
  type FormKind,
} from "../../../config/schemas/applications.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";

export const PLUGIN = "applications";

export function loadApplicationsConfig(guildConfig: GuildConfig): ApplicationsConfig {
  return parsePluginConfig(zApplicationsConfig, getPluginSettings(guildConfig, PLUGIN));
}

export function findOpening(config: ApplicationsConfig, openingId: string): ApplicationOpening | undefined {
  return config.openings.find((o) => o.id === openingId);
}

/** What each kind of form is called in Discord messages. */
export const FORM_KIND_NOUNS: Record<FormKind, string> = {
  application: "application",
  rsvp: "RSVP",
  questionnaire: "response",
  poll: "vote",
  feedback: "feedback",
  report: "report",
  signup: "sign-up",
  custom: "response",
};

export function openingName(opening: Pick<ApplicationOpening, "name"> & { kind?: FormKind }): string {
  return opening.name.trim() || (opening.kind && opening.kind !== "application" ? "Form" : "Application");
}

export function modalTitle(opening: ApplicationOpening): string {
  const fallback = opening.kind === "application" ? `${openingName(opening)} application` : openingName(opening);
  return (opening.modal_title.trim() || fallback).slice(0, 45);
}

/** The opening's own review channel, else the plugin-wide default. */
export function reviewChannelFor(config: ApplicationsConfig, opening: ApplicationOpening): string | undefined {
  return opening.review_channel_id?.trim() || config.review_channel_id?.trim() || undefined;
}

/** Template vars every Forms message can use on top of the usual {user}/{guild}/... ones. */
export function openingVars(opening: ApplicationOpening): Record<string, string> {
  const vars: Record<string, string> = {
    opening: openingName(opening),
    opening_description: opening.description.trim(),
    form: openingName(opening),
    form_description: opening.description.trim(),
  };
  if (opening.kind === "rsvp") {
    const start = Date.parse(opening.event.starts_at ?? "");
    vars.event_time = Number.isFinite(start) ? `<t:${Math.floor(start / 1000)}:F>` : "";
    vars.event_relative = Number.isFinite(start) ? `<t:${Math.floor(start / 1000)}:R>` : "";
    vars.location = opening.event.location.trim();
    vars.capacity = opening.event.capacity > 0 ? String(opening.event.capacity) : "";
  }
  return vars;
}
