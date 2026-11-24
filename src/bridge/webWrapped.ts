/**
 * GET /bridge/users/:userId/wrapped?year= — the signed-in user's own Dreamliner Wrapped.
 *
 * The website puts its session's Discord id in the path (never a browser-supplied id), behind the
 * bridge secret, so this only ever returns the caller's own recap. Outside the December to January
 * window it returns the "closed" state (with the phase, for the countdown). Dashboard superusers can
 * preview any edition with ?preview=1 (checked here against the superuser list, not trusted).
 */
import type { Client } from "discord.js";
import { buildWrapped, yearMessageTotals, type WrappedPayload } from "../core/wrapped/aggregate.js";
import { yearVoiceTotals } from "../core/wrapped/extras.js";
import { resolveWrappedAccess, wrappedWindow, type WrappedWindow } from "../core/wrapped/window.js";
import { cachedSwr } from "./responseCache.js";
import { isDashboardSuperuser } from "./superuser.js";

const HOUR = 60 * 60_000;

export type WrappedResponse =
  | { ok: true; status: "open"; preview: boolean; window: WrappedWindow; wrapped: WrappedPayload }
  | { ok: true; status: "closed"; window: WrappedWindow }
  | { ok: false; status: 400; error: string };

/** Slash command name to the plugin that owns it (for "favourite plugin"), built once. */
let pluginMap: Promise<(command: string) => string | undefined> | null = null;
function commandPluginMap(): Promise<(command: string) => string | undefined> {
  pluginMap ??= import("../plugins/availablePlugins.js").then(({ availablePlugins }) => {
    const map = new Map<string, string>();
    for (const plugin of availablePlugins) {
      for (const command of plugin.slashCommands ?? []) map.set(command.data.name, plugin.name);
      for (const command of plugin.contextMenuCommands ?? []) map.set(command.data.name.toLowerCase(), plugin.name);
    }
    return (command: string) => map.get(command);
  });
  return pluginMap;
}

export function parseWrappedYear(raw: string | null): number | null | "invalid" {
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d{4}$/.test(raw.trim())) return "invalid";
  return Number(raw.trim());
}

export async function getWrappedForWeb(client: Client, userId: string, rawYear: string | null, preview = false): Promise<WrappedResponse> {
  const window = wrappedWindow();
  const parsed = parseWrappedYear(rawYear);
  if (parsed === "invalid") return { ok: false, status: 400, error: "year must be a four-digit year." };
  const access = resolveWrappedAccess(parsed, { superuser: isDashboardSuperuser(userId), preview });
  if (!access.ok) {
    if (access.reason === "closed") return { ok: true, status: "closed", window };
    return { ok: false, status: 400, error: "That edition isn't available." };
  }
  const pluginOf = await commandPluginMap().catch(() => undefined);
  const wrapped = await cachedSwr(`wrapped:${userId}:${access.year}`, HOUR, 2 * HOUR, () =>
    buildWrapped(client, userId, access.year, {
      yearTotals: (year) => cachedSwr(`wrapped:totals:${year}`, HOUR, 6 * HOUR, async () => yearMessageTotals(year)),
      voiceTotals: (year) => cachedSwr(`wrapped:voice-totals:${year}`, HOUR, 6 * HOUR, async () => yearVoiceTotals(year)),
      pluginOf,
    }),
  );
  return { ok: true, status: "open", preview: access.preview, window, wrapped };
}
