import type { Guild } from "discord.js";
import { buildWatchdogList, type WatchdogUser } from "./watchdogScoring.js";

export type WebWatchdogPayload = {
  users: WatchdogUser[];
  scannedAt: string;
};

export async function buildWebWatchdogList(guild: Guild): Promise<WebWatchdogPayload> {
  const users = await buildWatchdogList(guild);
  return { users, scannedAt: new Date().toISOString() };
}
