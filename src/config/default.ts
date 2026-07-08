import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { GuildConfig } from "./schemas/guild.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedDefault: GuildConfig | null = null;

export function getDefaultConfigPath(): string {
  return join(__dirname, "../../config/default.server.yaml");
}

export function loadDefaultConfigRaw(): string {
  return readFileSync(getDefaultConfigPath(), "utf-8");
}

export function loadDefaultConfig(): GuildConfig {
  if (!cachedDefault) {
    cachedDefault = YAML.parse(loadDefaultConfigRaw()) as GuildConfig;
  }
  return structuredClone(cachedDefault);
}

export function clearDefaultConfigCache() {
  cachedDefault = null;
}
