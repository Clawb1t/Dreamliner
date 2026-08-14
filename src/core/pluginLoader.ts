import type { Client } from "discord.js";
import { Collection } from "discord.js";
import type { ConfigManager } from "../config/manager.js";
import { collectCommands } from "./plugin.js";
import { setSchedulerClient } from "./scheduler.js";
import type { BotContext, DreamlinerPlugin, InteractionStore } from "./types.js";

function runPluginEvent(
  pluginName: string,
  eventName: string,
  task: () => Promise<void>,
): void {
  void task().catch((error) => {
    console.error(`[${pluginName}] ${eventName} handler failed:`, error);
  });
}

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

  for (const plugin of plugins) {
    for (const event of plugin.events ?? []) {
      const run = (...args: unknown[]) => {
        runPluginEvent(plugin.name, event.name, () => event.execute(client, ...args));
      };
      if (event.once) {
        client.once(event.name, run);
      } else {
        client.on(event.name, run);
      }
    }
  }

  return ctx;
}

export function getPluginByName(plugins: DreamlinerPlugin[], name: string): DreamlinerPlugin | undefined {
  return plugins.find((p) => p.name === name);
}
