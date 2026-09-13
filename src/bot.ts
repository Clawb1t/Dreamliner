import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
} from "discord.js";
import type { ConfigManager } from "./config/manager.js";
import { loadPlugins } from "./core/pluginLoader.js";
import { availablePlugins } from "./plugins/availablePlugins.js";
import { resultReply, guildResultOptions } from "./core/responses.js";
import {
  getUtilityPluginConfig,
  getInfractionPluginConfig,
  pluginsRequiringConfig,
} from "./core/guildHelpers.js";
import { hasPermission } from "./core/permissionRoles.js";
import { pluginEnabled } from "./core/pluginCommand.js";
import {
  configEditorWithSupportRow,
  resolveDocsUrl,
  supportLinkRow,
} from "./core/docsUrl.js";
import { resolveEphemeral } from "./core/ephemeral.js";
import { canUseUtility } from "./core/guildHelpers.js";
import { handleHelpButton, handleHelpSelect, HELP_BUTTON_PREFIX } from "./plugins/utility/functions/help.js";
import { handleStatsInteraction, STATS_PREFIX } from "./plugins/stats/functions/ui/index.js";
import { handleSearchInteraction, SEARCH_PREFIX } from "./plugins/utility/functions/searchUi.js";
import { handleRoleButtonInteraction, ROLE_BUTTON_PREFIX } from "./plugins/role_buttons/index.js";
import { handleRolePanelButtonInteraction, ROLE_PANEL_PREFIX } from "./plugins/role_panels/index.js";
import {
  BOT_AVATAR_PREFIX,
  handleBotAvatarButtonInteraction,
} from "./plugins/bot_customisation/index.js";
import {
  handleScamProtectButtonInteraction,
  SCAM_PROTECT_STATS_PREFIX,
} from "./plugins/scam_protect/functions/buttons.js";
import {
  REVIEW_MODAL_ID,
  handleReviewModalSubmit,
} from "./plugins/reviews/functions/modal.js";
import {
  SUGGEST_ANON_MODAL_ID,
  SUGGEST_MODAL_ID,
  SUGGEST_PREFIX,
} from "./plugins/suggestions/constants.js";
import { handleSuggestModalSubmit } from "./plugins/suggestions/functions/modal.js";
import { handleSuggestionButtonInteraction } from "./plugins/suggestions/functions/handlers.js";
import { TICKET_PREFIX } from "./plugins/tickets/constants.js";
import {
  handleTicketButtonInteraction,
  handleTicketModalSubmit,
  handleTicketSelectMenuInteraction,
} from "./plugins/tickets/functions/panels.js";
import {
  handleWelcomeWaveButtonInteraction,
  WELCOME_WAVE_CUSTOM_ID,
} from "./plugins/welcome_message/functions/waveButton.js";
import {
  CONTEXT_NAV_PREFIX,
  handleContextNavButtonInteraction,
} from "./plugins/utility/functions/contextNav.js";
import {
  EXPAND_DELETE_PREFIX,
  handleExpandDeleteButtonInteraction,
} from "./plugins/utility/functions/expandDeleteButton.js";
import {
  handleCompanionEntitySelect,
  handleCompanionModalSubmit,
  handleCompanionSelectInteraction,
} from "./plugins/companion_channels/functions/interface.js";
import { handleTranslateAutocomplete } from "./plugins/translation/commands.js";
import { handleTtsAutocomplete } from "./plugins/tts/commands.js";
import { handleTimeAutocomplete } from "./plugins/utility/functions/time.js";
import {
  handlePlanesAutocomplete,
  handlePlaneInventoryButtonInteraction,
  handlePlanePackButtonInteraction,
  handlePlaneSellButtonInteraction,
  handlePlaneStatsButtonInteraction,
  PLANE_INVENTORY_PREFIX,
  PLANE_PACK_PREFIX,
  PLANE_SELL_PREFIX,
  PLANE_STATS_PREFIX,
} from "./plugins/economy/index.js";
import { applyBotPresence } from "./core/presence.js";
import type { BotContext } from "./core/types.js";
import { handleDreamCommandSlash } from "./plugins/dream_commands/index.js";
import { startDashboardBridge } from "./bridge/dashboardBridge.js";
import { startStatusMonitor } from "./core/statusMonitor.js";
import { getLogger } from "./core/logger.js";
const log = getLogger("bot");
const cmdLog = getLogger("commands");

const pluginConfigGetters: Record<string, typeof getUtilityPluginConfig> = {
  utility: getUtilityPluginConfig,
  infractions: getInfractionPluginConfig,
};

async function resolveDispatchPluginConfig(
  pluginName: string,
  guildId: string,
  guildConfig: import("./config/schemas/guild.js").GuildConfig,
  member: import("discord.js").GuildMember | undefined,
): Promise<Record<string, unknown>> {
  const getter = pluginConfigGetters[pluginName];
  return getter ? getter(guildId, guildConfig, member) : {};
}

export async function createBot(configManager: ConfigManager): Promise<{ client: Client; ctx: BotContext }> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildBans,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.AutoModerationConfiguration,
      GatewayIntentBits.AutoModerationExecution,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
  });

  client.on(Events.Error, (error) => {
    log.error("[discord] Client error:", error);
  });

  const ctx = await loadPlugins(client, configManager, availablePlugins);

  client.once(Events.ClientReady, (c) => {
    applyBotPresence(c);
    log.info(`Dreamliner ready as ${c.user.tag}`);
    startStatusMonitor(c);
    startDashboardBridge(c, configManager);
    void import("./bridge/oneEntitlements.js").then(({ startDreamlinerOneEntitlements }) =>
      startDreamlinerOneEntitlements(c).catch((error) => {
        log.error("[dreamliner-one] Failed to start entitlement sync.", error);
      }),
    );
    // Self-heals native AutoMod drift (a rule someone deleted/edited by hand in Discord's
    // own settings) for every guild that opted in, without staff needing to remember to
    // hit "Sync now" on the dashboard after a restart.
    void import("./plugins/automod/functions/nativeSync.js").then(({ resyncAllNativeAutomod }) =>
      resyncAllNativeAutomod(c).catch((error) => {
        log.error("[automod] Native AutoMod boot resync failed.", error);
      }),
    );
  });

  client.on(Events.EntitlementCreate, (entitlement) => {
    void import("./bridge/oneEntitlements.js").then(({ handleDiscordEntitlement }) =>
      handleDiscordEntitlement(entitlement),
    );
  });
  client.on(Events.EntitlementUpdate, (_old, entitlement) => {
    void import("./bridge/oneEntitlements.js").then(({ handleDiscordEntitlement }) =>
      handleDiscordEntitlement(entitlement),
    );
  });
  client.on(Events.EntitlementDelete, (entitlement) => {
    void import("./bridge/oneEntitlements.js").then(({ handleDiscordEntitlementDelete }) =>
      handleDiscordEntitlementDelete(entitlement),
    );
  });

  client.on(Events.GuildCreate, async (guild) => {
    log.success(
      `Joined guild "${guild.name}" (${guild.id}) — ${guild.memberCount} members. Now in ${client.guilds.cache.size} guild(s).`,
    );

    const stored = await configManager.getGuildConfig(guild.id);
    if (stored) return;

    // Provision a default config immediately so every command works out of the
    // box; the guild can still customize (and overwrite this) via the dashboard
    // or /config later. Without this, pluginsRequiringConfig gates commands
    // like /warn until someone explicitly saves a config.
    const provisioned = await configManager.saveGuildConfig(guild.id, "", "system:auto-onboard");
    if (!provisioned.success) {
      log.error(
        `[dreamliner] Failed to provision default config for guild ${guild.id}:`,
        provisioned.errors,
      );
    }

    const { sendGuildOnboardingMessage } = await import("./core/guildOnboarding.js");
    await sendGuildOnboardingMessage(client, guild);
  });

  client.on(Events.GuildDelete, (guild) => {
    log.warn(
      `Left guild "${guild.name || guild.id}" (${guild.id}). Now in ${client.guilds.cache.size} guild(s).`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "translate") {
        await handleTranslateAutocomplete(interaction).catch((error) => {
          log.error("Translate autocomplete error:", error);
        });
        return;
      }
      if (interaction.commandName === "tts") {
        await handleTtsAutocomplete(interaction).catch((error) => {
          log.error("TTS autocomplete error:", error);
        });
        return;
      }
      if (interaction.commandName === "planes" || interaction.commandName === "planesadmin") {
        await handlePlanesAutocomplete(interaction).catch((error) => {
          log.error("Planes autocomplete error:", error);
        });
        return;
      }
      if (interaction.commandName === "time") {
        await handleTimeAutocomplete(interaction).catch((error) => {
          log.error("Time autocomplete error:", error);
        });
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(ctx, configManager, interaction);
      return;
    }
    if (interaction.isMessageContextMenuCommand()) {
      await handleContextMenuCommand(ctx, configManager, interaction);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(BOT_AVATAR_PREFIX)) {
        const handled = await handleBotAvatarButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId === SCAM_PROTECT_STATS_PREFIX) {
        const handled = await handleScamProtectButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(SUGGEST_PREFIX)) {
        const handled = await handleSuggestionButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await handleTicketButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId === WELCOME_WAVE_CUSTOM_ID) {
        const handled = await handleWelcomeWaveButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(CONTEXT_NAV_PREFIX)) {
        const handled = await handleContextNavButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(EXPAND_DELETE_PREFIX)) {
        const handled = await handleExpandDeleteButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_STATS_PREFIX)) {
        const handled = await handlePlaneStatsButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_PACK_PREFIX)) {
        const handled = await handlePlanePackButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_INVENTORY_PREFIX)) {
        const handled = await handlePlaneInventoryButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_SELL_PREFIX)) {
        const handled = await handlePlaneSellButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(ROLE_BUTTON_PREFIX)) {
        const handled = await handleRoleButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(ROLE_PANEL_PREFIX)) {
        const handled = await handleRolePanelButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await handleStatsButtonInteraction(configManager, interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${SEARCH_PREFIX}:`)) {
        const handled = await handleSearchButtonInteraction(configManager, interaction);
        if (handled) return;
      }
      await handleHelpButtonInteraction(configManager, interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await handleTicketSelectMenuInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await handleStatsSelectInteraction(configManager, interaction);
        if (handled) return;
      }
      const companionSelect = await handleCompanionSelectInteraction(interaction);
      if (companionSelect) return;
      await handleHelpSelectInteraction(configManager, interaction);
      return;
    }
    if (interaction.isUserSelectMenu() || interaction.isMentionableSelectMenu()) {
      const handled = await handleCompanionEntitySelect(interaction);
      if (handled) return;
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await handleTicketModalSubmit(interaction);
        if (handled) return;
      }
      if (interaction.customId === REVIEW_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "reviews"))) return;
        try {
          await handleReviewModalSubmit(interaction, configManager);
        } catch (error) {
          log.error("Review modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that review. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      if (interaction.customId === SUGGEST_MODAL_ID || interaction.customId === SUGGEST_ANON_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "suggestions"))) return;
        try {
          await handleSuggestModalSubmit(interaction, configManager);
        } catch (error) {
          log.error("Suggest modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that suggestion. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      const companionModal = await handleCompanionModalSubmit(interaction);
      if (companionModal) return;
    }
  });

  return { client, ctx };
}

async function ensurePluginEnabledForModal(
  configManager: ConfigManager,
  interaction: import("discord.js").ModalSubmitInteraction,
  pluginName: string,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "This can only be used in a server.", flags: MessageFlags.Ephemeral });
    return false;
  }
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, pluginName)) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        `The **${pluginName}** plugin is disabled for this server.`,
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return false;
  }
  return true;
}

async function handleContextMenuCommand(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction: import("discord.js").MessageContextMenuCommandInteraction,
) {
  const command = ctx.contextMenuCommands.get(interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);

  if (command.plugin !== "config" && !pluginEnabled(guildConfig, command.plugin)) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        `The **${command.plugin}** plugin is disabled for this server.`,
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  if (command.manageServer) {
    const member = interaction.member;
    if (!member || typeof member === "string" || !("permissions" in member)) return;
    if (!(member as import("discord.js").GuildMember).permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(
        resultReply(
          "Permission denied",
          "You need **Manage Server** to use this command.",
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return;
    }
  }

  if (command.plugin !== "config" && pluginsRequiringConfig.has(command.plugin)) {
    const hasStoredConfig = (await configManager.getGuildConfig(interaction.guildId)) !== null;
    if (!hasStoredConfig) {
      await interaction.reply(
        resultReply(
          "Configuration required",
          "This server has no configuration yet. Open the dashboard (or run `/config`) to set up Dreamliner, then save.",
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          [configEditorWithSupportRow(interaction.guildId!)],
        ),
      );
      return;
    }
  }

  if (command.permission && command.plugin !== "config") {
    const member = interaction.member;
    if (!member || typeof member === "string") return;
    const guildMember = member as import("discord.js").GuildMember;

    if (!(await hasPermission(interaction.guildId!, command.plugin, command.permission, guildMember, guildConfig))) {
      await interaction.reply(
        resultReply(
          "Permission denied",
          "You do not have permission to use this command.",
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return;
    }
  }

  if (command.discordPermissions) {
    const member = interaction.member;
    if (!member || typeof member === "string" || !("permissions" in member)) return;
    if (!(member as import("discord.js").GuildMember).permissions.has(command.discordPermissions)) {
      await interaction.reply(
        resultReply(
          "Permission denied",
          "You lack required Discord permissions.",
          true,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
        ),
      );
      return;
    }
  }

  const member = interaction.member;
  const guildMember = member && typeof member !== "string" ? (member as import("discord.js").GuildMember) : undefined;
  const pluginConfig = await resolveDispatchPluginConfig(command.plugin, interaction.guildId!, guildConfig, guildMember);

  try {
    await command.execute({
      interaction,
      guildConfig,
      pluginConfig,
      client: ctx.client,
      configManager,
    });
    const { trackCommandUsage } = await import("./plugins/stats/functions/commandUsage.js");
    trackCommandUsage(interaction.guildId, interaction.commandName);
    cmdLog.info(
      `${interaction.commandName} (context menu) used by ${interaction.user.tag} in "${interaction.guild?.name ?? interaction.guildId}" (${interaction.guildId})`,
    );
  } catch (error) {
    log.error(`Error in context menu ${interaction.commandName}:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Error",
            "An unexpected error occurred. If this keeps happening, ask in the support server.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
            [supportLinkRow()],
          ),
        )
        .catch(() => null);
    }
  }
}

async function handleSlashCommand(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  const command = ctx.commands.get(interaction.commandName);
  if (!command) {
    // Guild-scoped custom slash commands are not in the global command map.
    const handled = await handleDreamCommandSlash(interaction, configManager).catch((error) => {
      log.error("Custom slash command error:", error);
      return true;
    });
    if (!handled && !interaction.replied && !interaction.deferred) {
      // Unknown command — ignore quietly (Discord may still show it briefly after deletes).
    }
    return;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const ephemeral = resolveEphemeral(guildConfig);

  // Config stays available so staff can re-enable plugins; everything else respects `enabled`.
  if (command.plugin !== "config" && !pluginEnabled(guildConfig, command.plugin)) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        `The **${command.plugin}** plugin is disabled for this server.`,
        ephemeral,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  if (command.manageServer) {
    const member = interaction.member;
    if (!member || typeof member === "string" || !("permissions" in member)) return;
    if (!(member as import("discord.js").GuildMember).permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(resultReply("Permission denied", "You need **Manage Server** to use this command.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return;
    }
  }

  if (command.plugin !== "config" && pluginsRequiringConfig.has(command.plugin)) {
    const hasStoredConfig = (await configManager.getGuildConfig(interaction.guildId)) !== null;
    if (!hasStoredConfig) {
      await interaction.reply(
        resultReply(
          "Configuration required",
          "This server has no configuration yet. Open the dashboard (or run `/config`) to set up Dreamliner, then save.",
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          [configEditorWithSupportRow(interaction.guildId!)],
        ),
      );
      return;
    }
  }

  if (command.permission && command.plugin !== "config") {
    const member = interaction.member;
    if (!member || typeof member === "string") return;
    const guildMember = member as import("discord.js").GuildMember;

    if (!(await hasPermission(interaction.guildId!, command.plugin, command.permission, guildMember, guildConfig))) {
      await interaction.reply(resultReply("Permission denied", "You do not have permission to use this command.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return;
    }
  }

  if (command.discordPermissions) {
    const member = interaction.member;
    if (!member || typeof member === "string" || !("permissions" in member)) return;
    if (!(member as import("discord.js").GuildMember).permissions.has(command.discordPermissions)) {
      await interaction.reply(resultReply("Permission denied", "You lack required Discord permissions.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return;
    }
  }

  const member = interaction.member;
  const guildMember = member && typeof member !== "string" ? (member as import("discord.js").GuildMember) : undefined;
  const pluginConfig = await resolveDispatchPluginConfig(command.plugin, interaction.guildId!, guildConfig, guildMember);

  try {
    await command.execute({
      interaction,
      guildConfig,
      pluginConfig,
      client: ctx.client,
      configManager,
      ephemeral,
    });
    const { trackCommandUsage } = await import("./plugins/stats/functions/commandUsage.js");
    trackCommandUsage(interaction.guildId, interaction.commandName);
    cmdLog.info(
      `/${interaction.commandName} used by ${interaction.user.tag} in "${interaction.guild?.name ?? interaction.guildId}" (${interaction.guildId})`,
    );
  } catch (error) {
    log.error(`Error in /${interaction.commandName}:`, error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Error",
            "An unexpected error occurred. If this keeps happening, ask in the support server.",
            ephemeral,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
            [supportLinkRow()],
          ),
        )
        .catch(() => null);
    }
  }
}

async function handleHelpInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction,
  run: (
    interaction: import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction,
    docsUrl: string,
    emojis: import("./config/schemas/guild.js").GuildConfig["emojis"],
  ) => Promise<void>,
) {
  if (!interaction.customId.startsWith(`${HELP_BUTTON_PREFIX}:`)) return;
  if (!interaction.inGuild() || !interaction.guildId) return;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "utility")) {
    await interaction.reply(
      resultReply(
        "Plugin disabled",
        "The **utility** plugin is disabled for this server.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") return;

  const guildMember = member as import("discord.js").GuildMember;

  if (!(await canUseUtility(interaction.guildId, guildConfig, "can_help", guildMember))) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to use help.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const docsUrl = resolveDocsUrl();

  try {
    await run(interaction, docsUrl, guildConfig.emojis);
  } catch (error) {
    log.error("Help interaction error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Error",
            "Could not update help. If this keeps happening, ask in the support server.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
            [supportLinkRow()],
          ),
        )
        .catch(() => null);
    }
  }
}

async function handleHelpButtonInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").ButtonInteraction,
) {
  await handleHelpInteraction(configManager, interaction, (i, docsUrl, emojis) =>
    handleHelpButton(i as import("discord.js").ButtonInteraction, docsUrl, emojis),
  );
}

async function handleHelpSelectInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").StringSelectMenuInteraction,
) {
  await handleHelpInteraction(configManager, interaction, (i, docsUrl, emojis) =>
    handleHelpSelect(i as import("discord.js").StringSelectMenuInteraction, docsUrl, emojis),
  );
}

async function handleStatsButtonInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").ButtonInteraction,
): Promise<boolean> {
  return handleStatsPermissionInteraction(configManager, interaction);
}

async function handleStatsSelectInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").StringSelectMenuInteraction,
): Promise<boolean> {
  return handleStatsPermissionInteraction(configManager, interaction);
}

async function handleStatsPermissionInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${STATS_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guildId) return true;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "stats")) {
    const ephemeral = resolveEphemeral(guildConfig);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Plugin disabled",
            "The **stats** plugin is disabled for this server.",
            ephemeral,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
    return true;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") return true;
  const guildMember = member as import("discord.js").GuildMember;

  return handleStatsInteraction(interaction, guildConfig, (permission) =>
    hasPermission(interaction.guildId!, "stats", permission, guildMember, guildConfig),
  );
}

async function handleSearchButtonInteraction(
  configManager: ConfigManager,
  interaction: import("discord.js").ButtonInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${SEARCH_PREFIX}:`)) return false;
  if (!interaction.inGuild() || !interaction.guildId) return true;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  if (!pluginEnabled(guildConfig, "utility")) {
    const ephemeral = resolveEphemeral(guildConfig);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply(
          resultReply(
            "Plugin disabled",
            "The **utility** plugin is disabled for this server.",
            ephemeral,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    }
    return true;
  }

  const member = interaction.member;
  if (!member || typeof member === "string") return true;
  const guildMember = member as import("discord.js").GuildMember;

  return handleSearchInteraction(interaction, guildConfig, guildMember);
}

export async function registerApplicationCommands(token: string, clientId: string) {
  const slashBody = availablePlugins.flatMap((p) => p.slashCommands.map((cmd) => cmd.data.toJSON()));
  const contextBody = availablePlugins.flatMap((p) =>
    (p.contextMenuCommands ?? []).map((cmd) => cmd.data.toJSON()),
  );
  const body = [...slashBody, ...contextBody];

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body });
  log.info(`Registered ${slashBody.length} slash commands and ${contextBody.length} context menu commands.`);
}

/** @deprecated Use registerApplicationCommands */
export async function registerSlashCommands(token: string, clientId: string) {
  return registerApplicationCommands(token, clientId);
}
