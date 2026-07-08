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
import { resolveEphemeral } from "./core/ephemeral.js";
import { canUseUtility } from "./core/guildHelpers.js";
import { handleHelpButton, handleHelpSelect, HELP_BUTTON_PREFIX } from "./plugins/utility/functions/help.js";
import { handleRoleButtonInteraction, ROLE_BUTTON_PREFIX } from "./plugins/role_buttons/index.js";
import {
  handleSelfRoleButtonInteraction,
  handleSelfRoleSelectInteraction,
  SELF_ROLE_PREFIX,
} from "./plugins/self_grantable_roles/index.js";
import { applyBotPresence } from "./core/presence.js";
import type { BotContext } from "./core/types.js";

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
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  const ctx = await loadPlugins(client, configManager, availablePlugins);

  client.once(Events.ClientReady, (c) => {
    applyBotPresence(c);
    console.log(`Dreamliner ready as ${c.user.tag}`);
  });

  client.on(Events.GuildCreate, async (guild) => {
    const stored = await configManager.getGuildConfig(guild.id);
    if (stored) return;
    const channel = guild.systemChannel ?? guild.channels.cache.find((ch) => ch.isTextBased());
    if (channel?.isTextBased() && "send" in channel) {
      await channel
        .send(
          "Thanks for adding **Dreamliner**! Run `/config template` to download the configuration template, edit it, then `/config upload` to set up this server.",
        )
        .catch(() => null);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(ctx, configManager, interaction);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(ROLE_BUTTON_PREFIX)) {
        const handled = await handleRoleButtonInteraction(interaction);
        if (handled) return;
      }
      if (interaction.customId.startsWith(SELF_ROLE_PREFIX) && interaction.customId.includes(":", SELF_ROLE_PREFIX.length)) {
        const handled = await handleSelfRoleButtonInteraction(interaction);
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
      await handleHelpSelectInteraction(configManager, interaction);
    }
  });

  return { client, ctx };
}

async function handleSlashCommand(
  ctx: BotContext,
  configManager: ConfigManager,
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  const command = ctx.commands.get(interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const ephemeral = resolveEphemeral(guildConfig);

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
          "This server has no configuration yet. Use `/config template`, edit the file, then `/config upload`.",
          ephemeral,
          guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
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
      await interaction.reply(resultReply("Error", "An unexpected error occurred.", ephemeral, guildResultOptions(interaction.client, guildConfig, { tone: "error" }))).catch(() => null);
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

  const docsUrl = process.env.DOCS_BASE_URL ?? "https://github.com/your-org/dreamliner/blob/main/docs";

  try {
    await run(interaction, docsUrl, guildConfig.emojis);
  } catch (error) {
    console.error("Help interaction error:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(resultReply("Error", "Could not update help.", true, guildResultOptions(interaction.client, guildConfig, { tone: "error" }))).catch(() => null);
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

export async function registerSlashCommands(token: string, clientId: string) {
  const body = availablePlugins.flatMap((p) =>
    p.slashCommands.map((cmd) => cmd.data.toJSON()),
  );

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`Registered ${body.length} slash commands.`);
}
