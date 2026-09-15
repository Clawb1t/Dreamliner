export const STATS_PREFIX = "dl:stats";

import type { StatsWindow } from "../daily.js";
import { isValidStatsWindow } from "../daily.js";
import { defaultTranslator, type Translator } from "../../../../i18n/index.js";

export type { StatsWindow } from "../daily.js";

export type StatsScope =
  | { type: "server" }
  | { type: "user"; userId: string }
  | { type: "channel"; channelId: string };

export type StatsState = {
  scope: StatsScope;
  days: StatsWindow;
  category: string;
  chartPage: number;
};

export type StatsCategory = {
  id: string;
  label: string;
  description: string;
  charts: number;
};

function serverCategories(t: Translator): StatsCategory[] {
  return [
    { id: "home", label: t("stats.catOverview", "Overview"), description: t("stats.catServerOverviewDesc", "Key metrics and highlights"), charts: 0 },
    { id: "activity", label: t("stats.catActivity", "Activity"), description: t("stats.catServerActivityDesc", "Message volume over time"), charts: 3 },
    { id: "membership", label: t("stats.catMembership", "Membership"), description: t("stats.catMembershipDesc", "Joins, leaves, and active users"), charts: 3 },
    { id: "engagement", label: t("stats.catEngagement", "Engagement"), description: t("stats.catEngagementDesc", "Edits, deletes, reactions, attachments"), charts: 3 },
    { id: "leaders", label: t("stats.catLeaderboards", "Leaderboards"), description: t("stats.catLeaderboardsDesc", "Top messagers and channels"), charts: 3 },
  ];
}

function userCategories(t: Translator): StatsCategory[] {
  return [
    { id: "home", label: t("stats.catOverview", "Overview"), description: t("stats.catUserOverviewDesc", "Lifetime totals and rank"), charts: 0 },
    { id: "activity", label: t("stats.catActivity", "Activity"), description: t("stats.catDailyPatternsDesc", "Daily message patterns"), charts: 3 },
    { id: "patterns", label: t("stats.catPatterns", "Patterns"), description: t("stats.catWeekdayTrafficDesc", "Weekday habits and traffic share"), charts: 2 },
  ];
}

function channelCategories(t: Translator): StatsCategory[] {
  return [
    { id: "home", label: t("stats.catOverview", "Overview"), description: t("stats.catChannelOverviewDesc", "Channel totals and context"), charts: 0 },
    { id: "activity", label: t("stats.catActivity", "Activity"), description: t("stats.catDailyPatternsDesc", "Daily message patterns"), charts: 3 },
    { id: "patterns", label: t("stats.catPatterns", "Patterns"), description: t("stats.catWeekdayTrafficDesc", "Weekday habits and traffic share"), charts: 2 },
  ];
}

export function categoriesFor(scope: StatsScope, t: Translator = defaultTranslator): StatsCategory[] {
  if (scope.type === "server") return serverCategories(t);
  if (scope.type === "user") return userCategories(t);
  return channelCategories(t);
}

export function categoryDef(scope: StatsScope, categoryId: string, t: Translator = defaultTranslator): StatsCategory {
  return categoriesFor(scope, t).find((c) => c.id === categoryId) ?? categoriesFor(scope, t)[0]!;
}

function serializeScope(scope: StatsScope): string {
  if (scope.type === "server") return "s";
  if (scope.type === "user") return `u:${scope.userId}`;
  return `c:${scope.channelId}`;
}

export function serializeStatsState(state: StatsState): string {
  return `${serializeScope(state.scope)}:${state.days}:${state.category}:${state.chartPage}`;
}

export function parseStatsState(raw: string): StatsState | null {
  const parts = raw.split(":");
  if (parts[0] === "s" && parts.length >= 4) {
    const days = Number(parts[1]);
    const category = parts[2]!;
    const chartPage = Number(parts[3] ?? 0);
    if (!isValidStatsWindow(days)) return null;
    return { scope: { type: "server" }, days, category, chartPage: Number.isFinite(chartPage) ? chartPage : 0 };
  }
  if (parts[0] === "u" && parts.length >= 5) {
    const days = Number(parts[2]);
    const category = parts[3]!;
    const chartPage = Number(parts[4] ?? 0);
    if (!isValidStatsWindow(days)) return null;
    return {
      scope: { type: "user", userId: parts[1]! },
      days,
      category,
      chartPage: Number.isFinite(chartPage) ? chartPage : 0,
    };
  }
  if (parts[0] === "c" && parts.length >= 5) {
    const days = Number(parts[2]);
    const category = parts[3]!;
    const chartPage = Number(parts[4] ?? 0);
    if (!isValidStatsWindow(days)) return null;
    return {
      scope: { type: "channel", channelId: parts[1]! },
      days,
      category,
      chartPage: Number.isFinite(chartPage) ? chartPage : 0,
    };
  }
  return null;
}

export function buildCustomId(action: string, state: StatsState): string {
  return `${STATS_PREFIX}:${action}:${serializeStatsState(state)}`.slice(0, 100);
}

export function parseCustomId(customId: string): { action: string; state: StatsState } | null {
  if (!customId.startsWith(`${STATS_PREFIX}:`)) return null;
  const rest = customId.slice(STATS_PREFIX.length + 1);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;
  const action = rest.slice(0, firstColon);
  const state = parseStatsState(rest.slice(firstColon + 1));
  if (!state) return null;
  return { action, state };
}

export function permissionForScope(scope: StatsScope): "can_server" | "can_user" | "can_channel" {
  if (scope.type === "user") return "can_user";
  if (scope.type === "channel") return "can_channel";
  return "can_server";
}
