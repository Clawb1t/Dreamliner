export const STATS_PREFIX = "dl:stats";

import type { StatsWindow } from "../daily.js";
import { isValidStatsWindow } from "../daily.js";

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

export const SERVER_CATEGORIES: StatsCategory[] = [
  { id: "home", label: "Overview", description: "Key metrics and highlights", charts: 0 },
  { id: "activity", label: "Activity", description: "Message volume over time", charts: 3 },
  { id: "membership", label: "Membership", description: "Joins, leaves, and active users", charts: 3 },
  { id: "engagement", label: "Engagement", description: "Edits, deletes, reactions, attachments", charts: 3 },
  { id: "leaders", label: "Leaderboards", description: "Top messagers and channels", charts: 3 },
];

export const USER_CATEGORIES: StatsCategory[] = [
  { id: "home", label: "Overview", description: "Lifetime totals and rank", charts: 0 },
  { id: "activity", label: "Activity", description: "Daily message patterns", charts: 3 },
  { id: "patterns", label: "Patterns", description: "Weekday habits and traffic share", charts: 2 },
];

export const CHANNEL_CATEGORIES: StatsCategory[] = [
  { id: "home", label: "Overview", description: "Channel totals and context", charts: 0 },
  { id: "activity", label: "Activity", description: "Daily message patterns", charts: 3 },
  { id: "patterns", label: "Patterns", description: "Weekday habits and traffic share", charts: 2 },
];

export function categoriesFor(scope: StatsScope): StatsCategory[] {
  if (scope.type === "server") return SERVER_CATEGORIES;
  if (scope.type === "user") return USER_CATEGORIES;
  return CHANNEL_CATEGORIES;
}

export function categoryDef(scope: StatsScope, categoryId: string): StatsCategory {
  return categoriesFor(scope).find((c) => c.id === categoryId) ?? categoriesFor(scope)[0]!;
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
