import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { resolveSiteUrl } from "../bridge/env.js";
import { publicLeaderboardUrl } from "./publicLeaderboard.js";

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

/** Public server page on the website. */
export function getGuildServerPageUrl(guildId: string): string {
  return `${resolveSiteUrl()}/server/${guildId}`;
}

/** Public Passport verification page for a guild. */
export function getPassportUrl(guildId: string): string {
  return `${resolveSiteUrl()}/passport/${guildId}`;
}

/** Guild-scoped dashboard (config editor for one server). */
export function getGuildDashboardUrl(guildId: string): string {
  return `${resolveSiteUrl()}/dashboard/${guildId}`;
}

/** Guild dashboard opened on the Stats section. */
export function getGuildStatsDashboardUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?section=stats`;
}

/** Guild dashboard opened on the Logs section. */
export function getGuildLogsDashboardUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?section=logs`;
}

/** Guild dashboard opened on the moderation Cases section. */
export function getGuildCasesDashboardUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?section=cases`;
}

/** Guild dashboard opened on the custom Commands section. */
export function getGuildCommandsDashboardUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?section=commands`;
}

/** Guild dashboard opened on the Social Notifications plugin page. */
export function getGuildSocialDashboardUrl(guildId: string): string {
  return `${getGuildDashboardUrl(guildId)}?section=plugin:social`;
}

/** Account page's Voice tab — lets a member preview and pick from every installed TTS voice. */
export function getAccountVoiceUrl(): string {
  return `${resolveSiteUrl()}/account?tab=voice`;
}

export function getGlobalStatsUrl(): string {
  return `${resolveSiteUrl()}/stats`;
}

/** Public Dreamliner Exchange page — top server stocks, trading. */
export function getStocksUrl(): string {
  return `${resolveSiteUrl()}/stocks`;
}

/** A single server's stock page on the Dreamliner Exchange. */
export function getGuildStockUrl(guildId: string): string {
  return `${getStocksUrl()}/${guildId}`;
}

export function getGlobalLeaderboardUrl(): string {
  return `${resolveSiteUrl()}/leaderboard/global`;
}

export function getStatusUrl(): string {
  return `${resolveSiteUrl()}/status`;
}

export function getInviteUrl(): string {
  return `${resolveSiteUrl()}/invite`;
}

/** @deprecated Prefer getDocsUrl(). */
export const DOCS_URL = getDocsUrl();
/** @deprecated Prefer getEditorUrl(). */
export const EDITOR_URL = getEditorUrl();

export const SUPPORT_URL = "https://discord.gg/cGzfZbtrpR";

export const VOTE_URL = "https://top.gg/bot/1524053555114151946";

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

export function configEditorLinkRow(guildId?: string): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow(
    { label: "Dashboard", url: guildId ? getGuildDashboardUrl(guildId) : getDashboardUrl() },
    { label: "Docs", url: docsPageUrl("configuration") },
  );
}

export function configEditorWithSupportRow(guildId?: string): ActionRowBuilder<ButtonBuilder> {
  return siteLinkRow(
    { label: "Dashboard", url: guildId ? getGuildDashboardUrl(guildId) : getDashboardUrl() },
    { label: "Docs", url: docsPageUrl("configuration") },
    { label: "Support server", url: SUPPORT_URL },
  );
}

/** Link row for stats replies: dashboard + public leaderboards. */
export function statsDashboardLinkRow(guildId: string): ActionRowBuilder<ButtonBuilder> {
  const publicLb = publicLeaderboardUrl(guildId);
  const buttons: Array<{ label: string; url: string }> = [
    { label: "Server dashboard", url: getGuildStatsDashboardUrl(guildId) },
    { label: "Global stats", url: getGlobalStatsUrl() },
    { label: "Global leaderboard", url: getGlobalLeaderboardUrl() },
  ];
  if (publicLb) buttons.splice(1, 0, { label: "Public leaderboard", url: publicLb });
  return siteLinkRow(...buttons.slice(0, 5));
}
