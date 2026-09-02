import { zWelcomeMessageConfig, type WelcomeMessageConfig } from "../../../config/schemas/welcome.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";

export async function loadWelcomeConfig(guildId: string): Promise<WelcomeMessageConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "welcome_message")) return null;
  return zWelcomeMessageConfig.parse(
    getPluginSettings(guildConfig, "welcome_message"),
  );
}
