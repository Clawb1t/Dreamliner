import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { resolveSiteUrl } from "../bridge/env.js";

/** Official website origin — follows DREAMLINER_ENV (local vs prod). */
export function getSiteUrl(): string {
  return resolveSiteUrl();
}

/** @deprecated Prefer getSiteUrl() — kept for call sites that import a constant. */
export const SITE_URL = resolveSiteUrl();

export function getDocsUrl(): string {
  return `${resolveSiteUrl()}/docs`;
}

export function getEditorUrl(): string {
  return `${resolveSiteUrl()}/dashboard`;
}

export function getDashboardUrl(): string {
  return `${resolveSiteUrl()}/dashboard`;
}

/** @deprecated Prefer getDocsUrl(). */
export const DOCS_URL = getDocsUrl();
/** @deprecated Prefer getEditorUrl(). */
export const EDITOR_URL = getEditorUrl();

export const SUPPORT_URL = "https://discord.gg/cGzfZbtrpR";

/** @deprecated Prefer DOCS_URL — kept for call sites that still resolve a base. */
export const DEFAULT_DOCS_URL = DOCS_URL;

export function resolveDocsUrl(): string {
  return getDocsUrl();
}

/** Build a docs page URL. Accepts legacy `.md` paths from help maps. */
export function docsPageUrl(page: string, base = getDocsUrl()): string {
  const clean = page
    .replace(/\.md$/i, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  const root = base.replace(/\/$/, "");
  if (!clean || clean === "index") return root;
  return `${root}/${clean}`;
}

export function linkButton(label: string, url: string): ButtonBuilder {
  return new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);
}

export function siteLinkRow(
  ...buttons: Array<{ label: string; url: string }>
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.slice(0, 5).map((b) => linkButton(b.label, b.url)),
  );
}

export function supportLinkRow(): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow({ label: "Support server", url: SUPPORT_URL });
}

export function configEditorLinkRow(): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow(
    { label: "Dashboard", url: getDashboardUrl() },
    { label: "Docs", url: docsPageUrl("configuration") },
  );
}

export function configEditorWithSupportRow(): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow(
    { label: "Dashboard", url: getDashboardUrl() },
    { label: "Docs", url: docsPageUrl("configuration") },
    { label: "Support server", url: SUPPORT_URL },
  );
}
