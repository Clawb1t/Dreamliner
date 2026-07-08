import type { Client } from "discord.js";
import { Collection } from "discord.js";
import type { ConfigManager } from "../config/manager.js";
import { collectCommands, collectEvents } from "./plugin.js";
import { setSchedulerClient } from "./scheduler.js";
import type { BotContext, DreamlinerPlugin, InteractionStore } from "./types.js";

export async function loadPlugins(
  client: Client,
  configManager: ConfigManager,
  plugins: DreamlinerPlugin[],
): Promise<BotContext> {
  const commands = new Collection<string, ReturnType<typeof collectCommands>[number]>();
  for (const cmd of collectCommands(plugins)) {
    commands.set(cmd.data.name, cmd);
  }

  const interactionStore: InteractionStore = {
    buttonHandlers: new Collection(),
  };

  const ctx: BotContext = {
    client,
    configManager,
    plugins,
    commands,
    interactionStore,
  };

  setSchedulerClient(client);

  for (const plugin of plugins) {
    if (plugin.onLoad) {
      await plugin.onLoad({ client, configManager });
    }
  }

  for (const event of collectEvents(plugins)) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(client, ...args));
    } else {
      client.on(event.name, (...args) => event.execute(client, ...args));
    }
  }

  return ctx;
}

export function getPluginByName(plugins: DreamlinerPlugin[], name: string): DreamlinerPlugin | undefined {
  return plugins.find((p) => p.name === name);
}
