import { ActivityType, type Client } from "discord.js";

export function applyBotPresence(client: Client): void {
  const shardId = client.shard?.ids[0] ?? 0;
  const shardNum = shardId + 1;
  const name = `✈️ dreamliner.site › #${String(shardNum).padStart(2, "0")}`;
  client.user?.setActivity(name, { type: ActivityType.Custom });
}
