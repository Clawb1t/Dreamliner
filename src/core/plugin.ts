import type { ZodType } from "zod";
import type { ContextMenuCommandDefinition, DreamlinerPlugin, EventHandler, SlashCommandDefinition } from "./types.js";

export function definePlugin(plugin: DreamlinerPlugin): DreamlinerPlugin {
  return plugin;
}

export function collectCommands(plugins: DreamlinerPlugin[]): SlashCommandDefinition[] {
  return plugins.flatMap((p) => p.slashCommands);
}

export function collectContextMenuCommands(plugins: DreamlinerPlugin[]): ContextMenuCommandDefinition[] {
  return plugins.flatMap((p) => p.contextMenuCommands ?? []);
}

export function collectEvents(plugins: DreamlinerPlugin[]): EventHandler[] {
  return plugins.flatMap((p) => p.events ?? []);
}

export type { DreamlinerPlugin, SlashCommandDefinition, ContextMenuCommandDefinition, ZodType };
