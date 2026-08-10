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
  getPluginDefaultOverrides,
  getUtilityPluginConfig,
  getInfractionPluginConfig,
  pluginsRequiringConfig,
} from "./core/guildHelpers.js";
import { hasPluginPermission } from "./core/permissions.js";
import { pluginEnabled } from "./core/pluginCommand.js";
import {
  configEditorWithSupportRow,
  getEditorUrl,
  resolveDocsUrl,
  SUPPORT_URL,
  supportLinkRow,
} from "./core/docsUrl.js";
import { resolveEphemeral } from "./core/ephemeral.js";
import { canUseUtility } from "./core/guildHelpers.js";
import { handleHelpButton, handleHelpSelect, HELP_BUTTON_PREFIX } from "./plugins/utility/functions/help.js";
import { handlePluginListButtonInteraction, PLUGIN_LIST_PREFIX } from "./plugins/config/pluginList.js";
import { handleStatsInteraction, STATS_PREFIX } from "./plugins/stats/functions/ui/index.js";
import { handleRoleButtonInteraction, ROLE_BUTTON_PREFIX } from "./plugins/role_buttons/index.js";
import {
  handleSelfRoleButtonInteraction,
  handleSelfRoleSelectInteraction,
  SELF_ROLE_PREFIX,
} from "./plugins/self_grantable_roles/index.js";
import {
  BOT_AVATAR_PREFIX,
  handleBotAvatarButtonInteraction,
} from "./plugins/bot_customisation/index.js";
import {
  handleScamProtectButtonInteraction,
  SCAM_PROTECT_STATS_PREFIX,
} from "./plugins/scam_protect/functions/buttons.js";
import {
  AUTOREACTION_ADD_MODAL_ID,
  handleAutoreactionModalSubmit,
} from "./plugins/autoreactions/functions/modal.js";
import {
  AUTOREPLY_ADD_MODAL_ID,
  handleAutoreplyModalSubmit,
} from "./plugins/autoreplies/functions/modal.js";
import {
  SLOWMODE_RULE_ADD_MODAL_ID,
  handleSlowmodeRuleModalSubmit,
} from "./plugins/slowmode/functions/modal.js";
import {
  AUTOROLE_ADD_MODAL_ID,
  handleAutoroleModalSubmit,
} from "./plugins/autorole/functions/modal.js";
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
import {
  handleWelcomeWaveButtonInteraction,
  WELCOME_WAVE_CUSTOM_ID,
} from "./plugins/welcome_message/functions/waveButton.js";
import { handleTranslateAutocomplete } from "./plugins/translation/commands.js";
import { handlePermissionsAutocomplete } from "./plugins/config/commands/permissions.js";
import { handlePluginAutocomplete } from "./plugins/config/commands/plugin.js";
import { applyBotPresence } from "./core/presence.js";
import type { BotContext } from "./core/types.js";
import { handleDreamCommandSlash } from "./plugins/dream_commands/index.js";
import { startDashboardBridge } from "./bridge/dashboardBridge.js";

const pluginConfigGetters: Record<string, typeof getUtilityPluginConfig> = {
  utility: getUtilityPluginConfig,
  infractions: getInfractionPluginConfig,
};

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
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
  });

  const ctx = await loadPlugins(client, configManager, availablePlugins);

  client.once(Events.ClientReady, (c) => {
    applyBotPresence(c);
    console.log(`Dreamliner ready as ${c.user.tag}`);
    startDashboardBridge(c, configManager);
  });

  client.on(Events.GuildCreate, async (guild) => {
    const stored = await configManager.getGuildConfig(guild.id);
    if (stored) return;
    const channel = guild.systemChannel ?? guild.channels.cache.find((ch) => ch.isTextBased());
    if (channel?.isTextBased() && "send" in channel) {
      await channel
        .send({
          content:
            `Thanks for adding **Dreamliner**! Open the [dashboard](${getEditorUrl()}) to edit this server's config in your browser, or use \`/config template\` + \`/config upload\`. Need help? Join the [support server](${SUPPORT_URL}).`,
          components: [configEditorWithSupportRow()],
        })
        .catch(() => null);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "permissions") {
        await handlePermissionsAutocomplete(interaction).catch((error) => {
          console.error("Permissions autocomplete error:", error);
        });
        return;
      }
      if (interaction.commandName === "plugin") {
        await handlePluginAutocomplete(interaction).catch((error) => {
          console.error("Plugin autocomplete error:", error);
        });
        return;
      }
      if (interaction.commandName === "translate") {
        await handleTranslateAutocomplete(interaction).catch((error) => {
          console.error("Translate autocomplete error:", error);
        });
      }
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(ctx, configManager, interaction);
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
      if (interaction.customId === WELCOME_WAVE_CUSTOM_ID) {
        const handled = await handleWelcomeWaveButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(ROLE_BUTTON_PREFIX)) {
        const handled = await handleRoleButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(SELF_ROLE_PREFIX) && interaction.customId.includes(":", SELF_ROLE_PREFIX.length)) {
        const handled = await handleSelfRoleButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${PLUGIN_LIST_PREFIX}:`)) {
        const handled = await handlePluginListButtonInteraction(interaction, (guildId) =>
          configManager.getEffectiveConfig(guildId),
        );
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await handleStatsButtonInteraction(configManager, interaction);
        if (handled) return;
      }
      await handleHelpButtonInteraction(configManager, interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith(SELF_ROLE_PREFIX)) {
        const handled = await handleSelfRoleSelectInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(`${STATS_PREFIX}:`)) {
        const handled = await handleStatsSelectInteraction(configManager, interaction);
        if (handled) return;
      }
      await handleHelpSelectInteraction(configManager, interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === AUTOREACTION_ADD_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "autoreactions"))) return;
        try {
          await handleAutoreactionModalSubmit(interaction, configManager);
        } catch (error) {
          console.error("Autoreaction modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that auto-reaction. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      if (interaction.customId === AUTOREPLY_ADD_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "autoreplies"))) return;
        try {
          await handleAutoreplyModalSubmit(interaction, configManager);
        } catch (error) {
          console.error("Autoreply modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that auto-reply. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      if (interaction.customId === SLOWMODE_RULE_ADD_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "slowmode"))) return;
        try {
          await handleSlowmodeRuleModalSubmit(interaction, configManager);
        } catch (error) {
          console.error("Slowmode modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that slowmode rule. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      if (interaction.customId === AUTOROLE_ADD_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "autorole"))) return;
        try {
          await handleAutoroleModalSubmit(interaction, configManager);
        } catch (error) {
          console.error("Autorole modal error:", error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction
              .reply(
                resultReply("Error", "Could not save that autorole. Ask in the support server if this continues.", true, undefined, [
                  supportLinkRow(),
                ]),
              )
              .catch(() => null);
          }
        }
        return;
      }
      if (interaction.customId === REVIEW_MODAL_ID) {
        if (!(await ensurePluginEnabledForModal(configManager, interaction, "reviews"))) return;
        try {
          await handleReviewModalSubmit(interaction, configManager);
        } catch (error) {
          console.error("Review modal error:", error);
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
          console.error("Suggest modal error:", error);
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
      }
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

async function handleSlashCommand(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  const command = ctx.commands.get(interaction.commandName);
  if (!command) {
    // Guild-scoped Dreamcode slash commands are not in the global command map.
    const handled = await handleDreamCommandSlash(interaction, configManager).catch((error) => {
      console.error("Dreamcode slash command error:", error);
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
          "This server has no configuration yet. Run `/config template` or `/config editor`, upload the YAML into the website editor, then `/config upload`.",
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          [configEditorWithSupportRow()],
        ),
      );
      return;
    }
  }

  if (command.permission && command.plugin !== "config") {
    const member = interaction.member;
    if (!member || typeof member === "string") return;
    const guildMember = member as import("discord.js").GuildMember;
    const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;

    const defaultOverrides = getPluginDefaultOverrides(command.plugin);
    if (
      !hasPluginPermission(
        guildConfig,
        command.plugin,
        command.permission,
        guildMember,
        interaction.channelId,
        categoryId,
        defaultOverrides,
      )
    ) {
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

  const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const member = interaction.member;
  const guildMember = member && typeof member !== "string" ? (member as import("discord.js").GuildMember) : undefined;
  const getter = pluginConfigGetters[command.plugin];
  const pluginConfig = getter ? getter(guildConfig, guildMember, interaction.channelId, categoryId) : {};

  try {
    await command.execute({
      interaction,
      guildConfig,
      pluginConfig,
      client: ctx.client,
      configManager,
      ephemeral,
    });
  } catch (error) {
    console.error(`Error in /${interaction.commandName}:`, error);
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
  const categoryId = interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;

  if (!canUseUtility(guildConfig, "can_help", guildMember, interaction.channelId, categoryId)) {
    await interaction.reply(
      resultReply("Permission denied", "You do not have permission to use help.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" })),
    );
    return;
  }

  const docsUrl = resolveDocsUrl();

  try {
    await run(interaction, docsUrl, guildConfig.emojis);
  } catch (error) {
    console.error("Help interaction error:", error);
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
  const categoryId =
    interaction.channel?.isTextBased() && "parentId" in interaction.channel ? interaction.channel.parentId : null;
  const defaultOverrides = getPluginDefaultOverrides("stats");

  return handleStatsInteraction(interaction, guildConfig, (permission) =>
    hasPluginPermission(
      guildConfig,
      "stats",
      permission,
      guildMember,
      interaction.channelId,
      categoryId,
      defaultOverrides,
    ),
  );
}

export async function registerSlashCommands(token: string, clientId: string) {
  const body = availablePlugins.flatMap((p) =>
    p.slashCommands.map((cmd) => cmd.data.toJSON()),
  );

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`Registered ${body.length} slash commands.`);
}
