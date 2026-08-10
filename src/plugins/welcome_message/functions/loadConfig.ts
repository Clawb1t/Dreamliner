import { zWelcomeMessageConfig, type WelcomeMessageConfig } from "../../../config/schemas/welcome.js";
import { configManager } from "../../../config/manager.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";

export async function loadWelcomeConfig(guildId: string): Promise<WelcomeMessageConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "welcome_message")) return null;
  return zWelcomeMessageConfig.parse(
    resolvePluginConfig(guildConfig, "welcome_message", getPluginDefaultOverrides("welcome_message")),
  );
}
