import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/** Official website and related links (hardcoded — no env override). */
export const SITE_URL = "https://www.dreamliner.site";
export const DOCS_URL = `${SITE_URL}/docs`;
export const EDITOR_URL = `${SITE_URL}/editor`;
export const SUPPORT_URL = "https://discord.gg/cGzfZbtrpR";

/** @deprecated Prefer DOCS_URL — kept for call sites that still resolve a base. */
export const DEFAULT_DOCS_URL = DOCS_URL;

export function resolveDocsUrl(): string {
  return DOCS_URL;
}

/** Build a docs page URL. Accepts legacy `.md` paths from help maps. */
export function docsPageUrl(page: string, base = DOCS_URL): string {
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
    { label: "Config editor", url: EDITOR_URL },
    { label: "Docs", url: docsPageUrl("configuration") },
  );
}

export function configEditorWithSupportRow(): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow(
    { label: "Config editor", url: EDITOR_URL },
    { label: "Docs", url: docsPageUrl("configuration") },
    { label: "Support server", url: SUPPORT_URL },
  );
}
