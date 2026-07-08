import { ActivityType, type Client } from "discord.js";

const DEFAULT_ACTIVITY = "Watching ✈️ Airplanes";

export function applyBotPresence(client: Client): void {
  const name = process.env.BOT_ACTIVITY?.trim() || DEFAULT_ACTIVITY;
  client.user?.setActivity(name, { type: ActivityType.Watching });
}
