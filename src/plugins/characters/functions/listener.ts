import { ChannelType, MessageType, type Client, type GuildMember, type Message, type Role } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { isDeepSeekConfigured } from "../../../core/ai/deepseek.js";
import { getLogger } from "../../../core/logger.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getOwnedWebhook, isOwnWebhookId } from "../../../core/webhooks.js";
import { CHARACTERS_WEBHOOK_NAME, PLUGIN } from "../constants.js";
import { checkMemberLimits } from "./limits.js";
import { charactersConfigOf, hasPendingTurn, postLimitNote, scheduleCharacterTurn } from "./respond.js";
import { clearDeletedRole, listCharacters } from "./store.js";
import { resolveCharacterTargets, shouldIgnoreMessage, type TriggerMessage } from "./triggers.js";

const log = getLogger("characters");

/** Message types members write (a plain message or a reply); everything else is a system message. */
function isSystemMessage(message: Message): boolean {
  return message.system || (message.type !== MessageType.Default && message.type !== MessageType.Reply);
}

/** MessageCreate: cheapest checks first, so servers without characters cost one cache lookup. */
export async function handleCharacterMessage(client: Client, message: Message): Promise<void> {
  if (
    shouldIgnoreMessage({
      authorBot: message.author.bot,
      webhookId: message.webhookId,
      inGuild: message.inGuild(),
      system: isSystemMessage(message),
    })
  ) {
    return;
  }
  const guild = message.guild!;
  const characters = listCharacters(guild.id).filter((c) => c.enabled && c.reviewStatus === "approved");
  if (!characters.length || !isDeepSeekConfigured()) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id).catch(() => null);
  if (!guildConfig || !pluginEnabled(guildConfig, PLUGIN)) return;
  const config = charactersConfigOf(guildConfig);

  const channel = message.channel;
  const thread = channel.isThread() ? channel : null;
  const parent = thread ? thread.parent : null;
  const base = parent ?? (channel.type === ChannelType.DM ? null : channel);
  const nsfw = Boolean(base && "nsfw" in base && base.nsfw);

  // The replied-to message, only when it could be a character's (it was posted by a webhook).
  let reference: TriggerMessage["reference"] = null;
  let ownWebhookId: string | null = null;
  if (config.triggers.reply && message.type === MessageType.Reply && message.reference?.messageId) {
    const ref = channel.messages.cache.get(message.reference.messageId) ?? (await message.fetchReference().catch(() => null));
    if (ref?.webhookId) {
      reference = { webhookId: ref.webhookId, authorName: ref.author.username };
      // After a restart the set of our webhook ids is empty: look the channel's webhook up once.
      if (!isOwnWebhookId(ref.webhookId) && characters.some((c) => c.name === ref.author.username)) {
        const owned = await getOwnedWebhook(channel, CHARACTERS_WEBHOOK_NAME, "Dreamliner characters", { create: false });
        ownWebhookId = owned?.webhook.id ?? null;
      }
    }
  }

  const matches = resolveCharacterTargets(
    {
      authorBot: false,
      webhookId: null,
      inGuild: true,
      system: false,
      content: message.content ?? "",
      channelId: channel.id,
      parentId: parent?.id ?? null,
      categoryId: base && "parentId" in base ? base.parentId ?? null : null,
      nsfw,
      reference,
    },
    characters,
    config,
    (id) => id === ownWebhookId || isOwnWebhookId(id),
  );
  if (!matches.length) return;

  const member = (message.member as GuildMember | null) ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member || !(await hasPermission(guild.id, PLUGIN, "can_talk", member, guildConfig))) return;

  for (const { character } of matches) {
    if (hasPendingTurn(channel.id, character.id)) {
      scheduleCharacterTurn(client, message, character.id);
      continue;
    }
    const limit = checkMemberLimits(guild.id, member.id, character.id, {
      cooldownSeconds: config.cooldown_seconds,
      dailyLimit: config.member_daily_limit,
    });
    if (limit === "daily") {
      await postLimitNote(message, "member", character.name).catch(() => null);
      continue;
    }
    if (limit === "cooldown") continue;
    scheduleCharacterTurn(client, message, character.id);
  }
}

/** GuildRoleDelete: a character whose role was deleted shows "Role missing" on the dashboard. */
export async function handleCharacterRoleDelete(role: Role): Promise<void> {
  try {
    clearDeletedRole(role.guild.id, role.id);
  } catch (err) {
    log.warn(`Couldn't clear a deleted character role in ${role.guild.id}: ${err instanceof Error ? err.message : err}`);
  }
}
