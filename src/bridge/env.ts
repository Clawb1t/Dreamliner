/** Dashboard / site environment: local testing vs production. */
export type DreamlinerEnv = "local" | "prod";

const DEFAULT_LOCAL = "http://localhost:3000";
const DEFAULT_PROD = "https://www.dreamliner.site";
const DEFAULT_BRIDGE_PORT = 4080;

export function getDreamlinerEnv(): DreamlinerEnv {
  const raw = (process.env.DREAMLINER_ENV ?? "prod").trim().toLowerCase();
  return raw === "local" ? "local" : "prod";
}

/** Public website origin (docs, editor links, dashboard). */
export function resolveSiteUrl(): string {
  const env = getDreamlinerEnv();
  const fromEnv =
    env === "local"
      ? process.env.DASHBOARD_URL_LOCAL?.trim()
      : process.env.DASHBOARD_URL_PROD?.trim();
  const fallback = env === "local" ? DEFAULT_LOCAL : DEFAULT_PROD;
  return (fromEnv || fallback).replace(/\/$/, "");
}

export function getDashboardBridgeSecret(): string | null {
  const secret = process.env.DASHBOARD_BRIDGE_SECRET?.trim();
  return secret || null;
}

/** Port for the bot's local HTTP bridge the website calls. */
export function getDashboardBridgePort(): number {
  const raw =
    process.env.DASHBOARD_BRIDGE_PORT?.trim() ||
    process.env.DASHBOARD_PORT?.trim() ||
    String(DEFAULT_BRIDGE_PORT);
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_BRIDGE_PORT;
}

export function isDashboardBridgeEnabled(): boolean {
  if (process.env.DASHBOARD_ENABLED?.trim().toLowerCase() === "false") return false;
  return Boolean(getDashboardBridgeSecret());
}
