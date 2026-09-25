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
  type RepliableInteraction,
} from "discord.js";
import type { ConfigManager } from "./config/manager.js";
import { loadPlugins } from "./core/pluginLoader.js";
import { availablePlugins } from "./plugins/availablePlugins.js";
import { resultReply, guildResultOptions, replyWithError, describeActionError } from "./core/responses.js";
import { trackCommandUsage } from "./plugins/stats/functions/commandUsage.js";
import { translatorFor } from "./i18n/index.js";
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
import { APPLICATION_PREFIX } from "./plugins/applications/constants.js";
import { BLUESKY_PREFIX } from "./plugins/bluesky/constants.js";
import { handleBlueskyButtonInteraction } from "./plugins/bluesky/functions/interactions.js";
import {
  handleApplicationButtonInteraction,
  handleApplicationModalSubmit,
} from "./plugins/applications/functions/interactions.js";
import { IMAGE_ANOTHER_PREFIX } from "./plugins/images/functions/render.js";
import { handleImageAnotherButton } from "./plugins/images/functions/buttons.js";
import {
  handleTicketButtonInteraction,
  handleTicketModalSubmit,
  handleTicketSelectMenuInteraction,
} from "./plugins/tickets/functions/panels.js";
import {
  GIVEAWAY_CLAIM_PREFIX,
  GIVEAWAY_ENTER_PREFIX,
  handleGiveawayAutocomplete,
  handleGiveawayClaimButton,
  handleGiveawayEnterButton,
} from "./plugins/giveaways/index.js";
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
import { LANGUAGE_SELECT_PREFIX, handleLanguageSelectInteraction } from "./plugins/language/index.js";
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
import { loadDefaultConfig } from "./config/default.js";
import type { BotContext, ContextMenuCommandDefinition, SlashCommandDefinition } from "./core/types.js";
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

const GENERIC_INTERACTION_ERROR = "An unexpected error occurred. If this keeps happening, ask in the support server.";

/**
 * Runs a button/select/modal handler and guarantees the interaction gets *some* reply if it
 * throws, instead of the click silently doing nothing (an unhandled rejection with no user-facing
 * feedback) or leaving a deferred interaction stuck on "thinking...". Preserves each handler's own
 * `boolean | void` "did I own this interaction" return so the `if (handled) return;` routing
 * above still works — on error we report `true` since we've already replied and shouldn't fall
 * through to another prefix check.
 */
async function safeHandle<T extends RepliableInteraction>(
  interaction: T,
  label: string,
  fn: () => Promise<boolean | void>,
  errorMessage: string = GENERIC_INTERACTION_ERROR,
): Promise<boolean> {
  try {
    const result = await fn();
    return result !== false;
  } catch (error) {
    log.error(`${label} error:`, error);
    await replyWithError(interaction, describeActionError(error, errorMessage));
    return true;
  }
}

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
    // Global safety net: any message the bot sends without its own `allowedMentions` (raw
    // `interaction.reply`/`channel.send`/etc. calls scattered across plugins — custom commands,
    // tags, autoreplies, etc. — often forward admin- or user-authored text verbatim) falls back
    // to this default instead of Discord's own "parse everything", so a body containing literal
    // "@everyone"/"@here" can never actually mass-ping. User/role mentions still work by default;
    // call sites that need to opt into an everyone/here ping (e.g. persist's `mention_everyone`)
    // already pass their own explicit `allowedMentions` and are unaffected.
    allowedMentions: { parse: ["users", "roles"] },
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
    // Dashboard-configured automatic Snapshots (src/config/snapshotSchedule.ts) — no Discord
    // client access needed, so a plain interval is enough.
    void import("./config/snapshotSchedule.js").then(({ runDueSnapshotSchedules }) => {
      setInterval(() => {
        runDueSnapshotSchedules().catch((error) => {
          log.error("[snapshots] Automatic snapshot sweep failed.", error);
        });
      }, 60_000);
    });
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
    try {
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
      await sendGuildOnboardingMessage(guild);
    } catch (error) {
      log.error(`[dreamliner] GuildCreate handler failed for guild ${guild.id}:`, error);
    }
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
      if (interaction.commandName === "giveaway") {
        await handleGiveawayAutocomplete(interaction).catch((error) => {
          log.error("Giveaway autocomplete error:", error);
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
    if (interaction.isUserContextMenuCommand()) {
      await handleContextMenuCommand(ctx, configManager, interaction);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(BOT_AVATAR_PREFIX)) {
        const handled = await safeHandle(interaction, "Bot avatar button", () => handleBotAvatarButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId === SCAM_PROTECT_STATS_PREFIX) {
        const handled = await safeHandle(interaction, "Scam protect button", () => handleScamProtectButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(SUGGEST_PREFIX)) {
        const handled = await safeHandle(interaction, "Suggestion button", () => handleSuggestionButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await safeHandle(interaction, "Ticket button", () => handleTicketButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(APPLICATION_PREFIX)) {
        const handled = await safeHandle(interaction, "Application button", () => handleApplicationButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(BLUESKY_PREFIX)) {
        const handled = await safeHandle(interaction, "Bluesky button", () => handleBlueskyButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(GIVEAWAY_ENTER_PREFIX)) {
        const handled = await safeHandle(interaction, "Giveaway enter button", () => handleGiveawayEnterButton(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(GIVEAWAY_CLAIM_PREFIX)) {
        const handled = await safeHandle(interaction, "Giveaway claim button", () => handleGiveawayClaimButton(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(IMAGE_ANOTHER_PREFIX)) {
        const handled = await safeHandle(interaction, "Image another button", () => handleImageAnotherButton(interaction));
        if (handled) return;
      }
      if (interaction.customId === WELCOME_WAVE_CUSTOM_ID) {
        const handled = await safeHandle(interaction, "Welcome wave button", () => handleWelcomeWaveButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(CONTEXT_NAV_PREFIX)) {
        const handled = await safeHandle(interaction, "Context nav button", () => handleContextNavButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(EXPAND_DELETE_PREFIX)) {
        const handled = await safeHandle(interaction, "Expand/delete button", () => handleExpandDeleteButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_STATS_PREFIX)) {
        const handled = await safeHandle(interaction, "Plane stats button", () => handlePlaneStatsButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_PACK_PREFIX)) {
        const handled = await safeHandle(interaction, "Plane pack button", () => handlePlanePackButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_INVENTORY_PREFIX)) {
        const handled = await safeHandle(interaction, "Plane inventory button", () => handlePlaneInventoryButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(PLANE_SELL_PREFIX)) {
        const handled = await safeHandle(interaction, "Plane sell button", () => handlePlaneSellButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(ROLE_BUTTON_PREFIX)) {
        const handled = await safeHandle(interaction, "Role button", () => handleRoleButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(ROLE_PANEL_PREFIX)) {
        const handled = await safeHandle(interaction, "Role panel button", () => handleRolePanelButtonInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await safeHandle(interaction, "Stats button", () => handleStatsButtonInteraction(configManager, interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${SEARCH_PREFIX}:`)) {
        const handled = await safeHandle(interaction, "Search button", () => handleSearchButtonInteraction(configManager, interaction));
        if (handled) return;
      }
      await safeHandle(interaction, "Help button", () => handleHelpButtonInteraction(configManager, interaction));
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === LANGUAGE_SELECT_PREFIX) {
        const handled = await safeHandle(interaction, "Language select", () => handleLanguageSelectInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await safeHandle(interaction, "Ticket select", () => handleTicketSelectMenuInteraction(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await safeHandle(interaction, "Stats select", () => handleStatsSelectInteraction(configManager, interaction));
        if (handled) return;
      }
      const companionSelect = await safeHandle(interaction, "Companion select", () => handleCompanionSelectInteraction(interaction));
      if (companionSelect) return;
      await safeHandle(interaction, "Help select", () => handleHelpSelectInteraction(configManager, interaction));
      return;
    }
    if (interaction.isUserSelectMenu() || interaction.isMentionableSelectMenu()) {
      await safeHandle(interaction, "Companion entity select", () => handleCompanionEntitySelect(interaction));
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(TICKET_PREFIX)) {
        const handled = await safeHandle(interaction, "Ticket modal", () => handleTicketModalSubmit(interaction));
        if (handled) return;
      }
      if (interaction.customId.startsWith(APPLICATION_PREFIX)) {
        const handled = await safeHandle(interaction, "Application modal", () => handleApplicationModalSubmit(interaction));
        if (handled) return;
      }
      if (interaction.customId === REVIEW_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "reviews"))) return;
        await safeHandle(
          interaction,
          "Review modal",
          () => handleReviewModalSubmit(interaction, configManager),
          "Could not save that review. Ask in the support server if this continues.",
        );
        return;
      }
      if (interaction.customId === SUGGEST_MODAL_ID || interaction.customId === SUGGEST_ANON_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "suggestions"))) return;
        await safeHandle(
          interaction,
          "Suggest modal",
          () => handleSuggestModalSubmit(interaction, configManager),
          "Could not save that suggestion. Ask in the support server if this continues.",
        );
        return;
      }
      await safeHandle(interaction, "Companion modal", () => handleCompanionModalSubmit(interaction));
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
    const { t } = await translatorFor(interaction.user.id);
    await interaction.reply(
      resultReply(
        t("common.pluginDisabledTitle", "Plugin disabled"),
        t("common.pluginDisabledBody", "The **{plugin}** plugin is disabled for this server.", { plugin: pluginName }),
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return false;
  }
  return true;
}

/**
 * Runs a `userInstallable` command outside a guild (DM/group DM via user-install, or a guild the
 * app isn't installed to). There's no guild config, member, or Dreamliner permission system to
 * consult there, so this skips every guild-only dispatch check (plugin enabled, manage server,
 * config-required, `can_*` permission, Discord permission bitfield) and runs the command straight
 * against the stock default config.
 */
async function runContextMenuCommandOutsideGuild(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction:
    | import("discord.js").MessageContextMenuCommandInteraction
    | import("discord.js").UserContextMenuCommandInteraction,
  command: ContextMenuCommandDefinition,
  locale: import("./i18n/index.js").Locale,
  t: import("./i18n/index.js").Translator,
) {
  const guildConfig = loadDefaultConfig();
  try {
    await command.execute({
      interaction,
      guildConfig,
      pluginConfig: {},
      client: ctx.client,
      configManager,
      locale,
      t,
    });
    trackCommandUsage(null, interaction.commandName);
    cmdLog.info(`${interaction.commandName} (context menu) used by ${interaction.user.tag} outside a guild (user app)`);
  } catch (error) {
    log.error(`Error in context menu ${interaction.commandName} (user app):`, error);
    await replyWithError(
      interaction,
      describeActionError(error, "An unexpected error occurred. If this keeps happening, ask in the support server."),
      guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
    );
  }
}

async function runSlashCommandOutsideGuild(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction: import("discord.js").ChatInputCommandInteraction,
  command: SlashCommandDefinition,
  locale: import("./i18n/index.js").Locale,
  t: import("./i18n/index.js").Translator,
) {
  const guildConfig = loadDefaultConfig();
  const ephemeral = resolveEphemeral(guildConfig);
  try {
    await command.execute({
      interaction,
      guildConfig,
      pluginConfig: {},
      client: ctx.client,
      configManager,
      ephemeral,
      locale,
      t,
    });
    trackCommandUsage(null, interaction.commandName);
    cmdLog.info(`/${interaction.commandName} used by ${interaction.user.tag} outside a guild (user app)`);
  } catch (error) {
    log.error(`Error in /${interaction.commandName} (user app):`, error);
    await replyWithError(
      interaction,
      describeActionError(error, "An unexpected error occurred. If this keeps happening, ask in the support server."),
      guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
    );
  }
}

async function handleContextMenuCommand(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction:
    | import("discord.js").MessageContextMenuCommandInteraction
    | import("discord.js").UserContextMenuCommandInteraction,
) {
  const command = ctx.contextMenuCommands.get(interaction.commandName);
  if (!command) return;

  const { locale, t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guildId) {
    if (!command.userInstallable) {
      await interaction.reply({
        content: t("common.guildOnlyCommand", "This command can only be used in a server."),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await runContextMenuCommandOutsideGuild(ctx, configManager, interaction, command, locale, t);
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);

  if (command.plugin !== "config" && !pluginEnabled(guildConfig, command.plugin)) {
    await interaction.reply(
      resultReply(
        t("common.pluginDisabledTitle", "Plugin disabled"),
        t("common.pluginDisabledBody", "The **{plugin}** plugin is disabled for this server.", { plugin: command.plugin }),
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
          t("common.permissionDeniedTitle", "Permission denied"),
          t("common.needManageServer", "You need **Manage Server** to use this command."),
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
          t("common.configRequiredTitle", "Configuration required"),
          t(
            "common.configRequiredBody",
            "This server has no configuration yet. Open the dashboard (or run `/config`) to set up Dreamliner, then save.",
          ),
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
          t("common.permissionDeniedTitle", "Permission denied"),
          t("common.noPermission", "You do not have permission to use this command."),
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
          t("common.permissionDeniedTitle", "Permission denied"),
          t("common.lackDiscordPermissions", "You lack required Discord permissions."),
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
      locale,
      t,
    });
    trackCommandUsage(interaction.guildId, interaction.commandName);
    cmdLog.info(
      `${interaction.commandName} (context menu) used by ${interaction.user.tag} in "${interaction.guild?.name ?? interaction.guildId}" (${interaction.guildId})`,
    );
  } catch (error) {
    log.error(`Error in context menu ${interaction.commandName}:`, error);
    await replyWithError(
      interaction,
      describeActionError(error, "An unexpected error occurred. If this keeps happening, ask in the support server."),
      guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
    );
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

  const { locale, t } = await translatorFor(interaction.user.id);

  if (!interaction.inGuild() || !interaction.guildId) {
    if (!command.userInstallable) {
      await interaction.reply({
        content: t("common.guildOnlyCommand", "This command can only be used in a server."),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await runSlashCommandOutsideGuild(ctx, configManager, interaction, command, locale, t);
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const ephemeral = resolveEphemeral(guildConfig);

  // Config stays available so staff can re-enable plugins; everything else respects `enabled`.
  if (command.plugin !== "config" && !pluginEnabled(guildConfig, command.plugin)) {
    await interaction.reply(
      resultReply(
        t("common.pluginDisabledTitle", "Plugin disabled"),
        t("common.pluginDisabledBody", "The **{plugin}** plugin is disabled for this server.", { plugin: command.plugin }),
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
      await interaction.reply(resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("common.needManageServer", "You need **Manage Server** to use this command."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return;
    }
  }

  if (command.plugin !== "config" && pluginsRequiringConfig.has(command.plugin)) {
    const hasStoredConfig = (await configManager.getGuildConfig(interaction.guildId)) !== null;
    if (!hasStoredConfig) {
      await interaction.reply(
        resultReply(
          t("common.configRequiredTitle", "Configuration required"),
          t(
            "common.configRequiredBody",
            "This server has no configuration yet. Open the dashboard (or run `/config`) to set up Dreamliner, then save.",
          ),
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
      await interaction.reply(resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("common.noPermission", "You do not have permission to use this command."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
      return;
    }
  }

  if (command.discordPermissions) {
    const member = interaction.member;
    if (!member || typeof member === "string" || !("permissions" in member)) return;
    if (!(member as import("discord.js").GuildMember).permissions.has(command.discordPermissions)) {
      await interaction.reply(resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("common.lackDiscordPermissions", "You lack required Discord permissions."), ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" })));
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
      locale,
      t,
    });
    trackCommandUsage(interaction.guildId, interaction.commandName);
    cmdLog.info(
      `/${interaction.commandName} used by ${interaction.user.tag} in "${interaction.guild?.name ?? interaction.guildId}" (${interaction.guildId})`,
    );
  } catch (error) {
    log.error(`Error in /${interaction.commandName}:`, error);
    await replyWithError(
      interaction,
      describeActionError(error, "An unexpected error occurred. If this keeps happening, ask in the support server."),
      guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
    );
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
  const { t } = await translatorFor(interaction.user.id);
  if (!pluginEnabled(guildConfig, "utility")) {
    await interaction.reply(
      resultReply(
        t("common.pluginDisabledTitle", "Plugin disabled"),
        t("common.pluginDisabledBody", "The **utility** plugin is disabled for this server.", { plugin: "utility" }),
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
      resultReply(t("common.permissionDeniedTitle", "Permission denied"), t("help.noPermission", "You do not have permission to use help."), true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
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
            t("common.errorTitle", "Error"),
            t("help.updateError", "Could not update help. If this keeps happening, ask in the support server."),
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
