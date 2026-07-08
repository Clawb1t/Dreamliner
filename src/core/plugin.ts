import type { ZodType } from "zod";
import type { ConfigOverride, DreamlinerPlugin, EventHandler, SlashCommandDefinition } from "./types.js";

export function definePlugin(plugin: DreamlinerPlugin): DreamlinerPlugin {
  return plugin;
}

export function collectCommands(plugins: DreamlinerPlugin[]): SlashCommandDefinition[] {
  return plugins.flatMap((p) => p.slashCommands);
}

export function collectEvents(plugins: DreamlinerPlugin[]): EventHandler[] {
  return plugins.flatMap((p) => p.events ?? []);
}

export type { DreamlinerPlugin, SlashCommandDefinition, ConfigOverride, ZodType };
