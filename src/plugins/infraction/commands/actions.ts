import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { resultReply, embedReply, slashResultOptions } from "../../../core/responses.js";
import { buildResultEmbed } from "../../../core/embeds.js";
import { requireInfractionPermission } from "../functions/commandHelpers.js";
import { requireDiscordPerm, BanMembers, KickMembers } from "../../utility/functions/commandHelpers.js";
import { canModerateTarget, formatReason } from "../functions/moderation.js";
import { parseDuration, formatDurationShort } from "../functions/duration.js";
import {
  applyTimeout,
  buildNotifyMessage,
  clearTimeout,
  clampTimeoutMs,
  createInfraction,
  deactivateInfractions,
  DISCORD_TIMEOUT_MAX_MS,
  dmUser,
  isTimedOut,
  isUserMuted,
  postCaseLog,
} from "../functions/infractions.js";
import { buildActionConfirmDetails } from "../functions/embeds.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";

async function finishAction(
  ctx: Parameters<SlashCommandDefinition["execute"]>[0],
  pluginConfig: InfractionConfig,
  type: string,
  user: import("discord.js").User,
  reason: string,
  record: Awaited<ReturnType<typeof createInfraction>>,
  extras?: string,
) {
  const durationLabel = extras?.match(/Duration: \*\*(.+)\*\*/)?.[1] ?? null;
  await postCaseLog(ctx.client, ctx.guildConfig, pluginConfig, record, user, ctx.interaction.user, { durationLabel });

  const notifyKey = type.replace("temp", "") as keyof InfractionConfig["notify"];
  const notifyMsg = buildNotifyMessage(pluginConfig, notifyKey in pluginConfig.notify ? notifyKey : "warn", {
    action: type,
    guild: ctx.interaction.guild!.name,
    reason,
    mod: ctx.interaction.user.tag,
    expires: record.expiresAt ? formatDurationShort(record.expiresAt.getTime() - Date.now()) : "",
  });
  if (notifyMsg) {
    const sent = await dmUser(user, pluginConfig, notifyKey in pluginConfig.notify ? notifyKey : "warn", notifyMsg);
    if (!sent) {
      const { buildDmFailedLog } = await import("../../../core/logging/format.js");
      const { sendModerationLog } = await import("../../../core/logging/send.js");
      await sendModerationLog(
        ctx.client,
        ctx.guildConfig,
        buildDmFailedLog(
          { id: user.id, name: user.username, avatarUrl: user.displayAvatarURL({ size: 128 }) },
          `/${type}`,
        ),
        {
          guildId: ctx.interaction.guildId!,
          eventType: "dm_failed",
          actorId: ctx.interaction.user.id,
          targetId: user.id,
          caseId: record.id,
          caseLogOverride: pluginConfig.case_log_channel,
        },
      );
    }
  }

  const details = buildActionConfirmDetails(type, user.tag, user.id, reason, extras);
  if (pluginConfig.confirm_actions) {
    await ctx.interaction.reply(
      embedReply(buildResultEmbed(`Infraction #${record.id}`, details, slashResultOptions(ctx)), ctx.ephemeral),
    );
  } else {
    await ctx.interaction.reply(resultReply(`Infraction #${record.id}`, details, ctx.ephemeral, slashResultOptions(ctx)));
  }
}

export const actionCommands: SlashCommandDefinition[] = [
  {
    plugin: "infractions",
    permission: "can_warn",
    data: new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member")
      .addUserOption((o) => o.setName("user").setDescription("Member to warn").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_warn");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err) {
        await ctx.interaction.reply(resultReply("Warn", err, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }
      const reason = formatReason(ctx.interaction.options.getString("reason"));
      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "warn",
        reason,
      });
      await finishAction(ctx, auth.pluginConfig, "warn", user, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_note",
    data: new SlashCommandBuilder()
      .setName("note")
      .setDescription("Add a staff note on a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Note")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_note");
      if (!auth) return;
      const user = ctx.interaction.options.getUser("user", true);
      const reason = formatReason(ctx.interaction.options.getString("reason"));
      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "note",
        reason,
        active: false,
      });
      await finishAction(ctx, auth.pluginConfig, "note", user, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_mute",
    discordPermissions: PermissionFlagsBits.ModerateMembers,
    data: new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Timeout a member (Discord mute)")
      .addUserOption((o) => o.setName("user").setDescription("Member to mute").setRequired(true))
      .addStringOption((o) =>
        o.setName("duration").setDescription("Timeout length (e.g. 30m, 2h, 1d; max 28d)").setRequired(true),
      )
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_mute");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err || !target) {
        await ctx.interaction.reply(resultReply("Mute", err ?? "Member not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (isTimedOut(target) || (await isUserMuted(ctx.interaction.guild!, user.id))) {
        await ctx.interaction.reply(resultReply("Mute", "That member is already timed out.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
        return;
      }

      const durationStr = ctx.interaction.options.getString("duration", true);
      const parsedMs = parseDuration(durationStr);
      if (!parsedMs) {
        await ctx.interaction.reply(resultReply("Mute", "Invalid duration. Use formats like `30m`, `2h`, `1d`.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const durationMs = clampTimeoutMs(parsedMs);
      if (parsedMs > DISCORD_TIMEOUT_MAX_MS) {
        await ctx.interaction.reply(
          resultReply(
            "Mute",
            "Discord timeouts cannot exceed **28 days**. Use a shorter duration.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const reason = formatReason(ctx.interaction.options.getString("reason"));
      try {
        await applyTimeout(target, durationMs, reason ?? "Dreamliner mute");
      } catch {
        await ctx.interaction.reply(
          resultReply(
            "Mute failed",
            "Could not apply timeout. Check that my role is above theirs and I have **Moderate Members**.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "tempmute",
        reason,
        expiresAt: new Date(Date.now() + durationMs),
        metadata: { method: "timeout" },
      });

      await finishAction(ctx, auth.pluginConfig, "tempmute", user, reason, record, `Duration: **${durationStr}**`);
    },
  },
  {
    plugin: "infractions",
    permission: "can_mute",
    discordPermissions: PermissionFlagsBits.ModerateMembers,
    data: new SlashCommandBuilder()
      .setName("unmute")
      .setDescription("Remove a member's timeout")
      .addUserOption((o) => o.setName("user").setDescription("Member to unmute").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_mute");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, PermissionFlagsBits.ModerateMembers, "Moderate Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      if (!target) {
        await ctx.interaction.reply(resultReply("Unmute", "Member not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (!isTimedOut(target) && !(await isUserMuted(ctx.interaction.guild!, user.id))) {
        await ctx.interaction.reply(resultReply("Unmute", "That member is not timed out.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const reason = formatReason(ctx.interaction.options.getString("reason"));
      try {
        await clearTimeout(target, reason ?? "Dreamliner unmute");
      } catch {
        await ctx.interaction.reply(
          resultReply(
            "Unmute failed",
            "Could not clear timeout. Check that my role is above theirs and I have **Moderate Members**.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "error" }),
          ),
        );
        return;
      }
      await deactivateInfractions(ctx.interaction.guildId!, user.id, ["mute", "tempmute"]);

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "unmute",
        reason,
        active: false,
      });
      await finishAction(ctx, auth.pluginConfig, "unmute", user, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_kick",
    discordPermissions: KickMembers,
    data: new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member")
      .addUserOption((o) => o.setName("user").setDescription("Member to kick").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_kick");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, KickMembers, "Kick Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err || !target) {
        await ctx.interaction.reply(resultReply("Kick", err ?? "Member not found.", ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const reason = formatReason(ctx.interaction.options.getString("reason"));
      await target.kick(reason);

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "kick",
        reason,
        active: false,
      });
      await finishAction(ctx, auth.pluginConfig, "kick", user, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_ban",
    discordPermissions: BanMembers,
    data: new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Permanently ban a member")
      .addUserOption((o) => o.setName("user").setDescription("Member to ban").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("delete_days").setDescription("Days of messages to delete (0-7)").setMinValue(0).setMaxValue(7),
      )
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_ban");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err) {
        await ctx.interaction.reply(resultReply("Ban", err, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const deleteDays = ctx.interaction.options.getInteger("delete_days") ?? auth.pluginConfig.ban_delete_message_days;
      const reason = formatReason(ctx.interaction.options.getString("reason"));

      await ctx.interaction.guild!.members.ban(user.id, { deleteMessageSeconds: deleteDays * 86400, reason });

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "ban",
        reason,
      });

      await finishAction(ctx, auth.pluginConfig, "ban", user, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_ban",
    discordPermissions: BanMembers,
    data: new SlashCommandBuilder()
      .setName("tempban")
      .setDescription("Temporarily ban a member")
      .addUserOption((o) => o.setName("user").setDescription("Member to tempban").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("Duration (e.g. 1d, 12h, 1w)").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("delete_days").setDescription("Days of messages to delete (0-7)").setMinValue(0).setMaxValue(7),
      )
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_ban");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err) {
        await ctx.interaction.reply(resultReply("Tempban", err, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const durationStr = ctx.interaction.options.getString("duration", true);
      const durationMs = parseDuration(durationStr);
      if (!durationMs) {
        await ctx.interaction.reply(
          resultReply("Tempban", "Invalid duration. Use formats like `30m`, `2h`, `1d`.", ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      const deleteDays = ctx.interaction.options.getInteger("delete_days") ?? auth.pluginConfig.ban_delete_message_days;
      const reason = formatReason(ctx.interaction.options.getString("reason"));

      await ctx.interaction.guild!.members.ban(user.id, { deleteMessageSeconds: deleteDays * 86400, reason });

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "tempban",
        reason,
        expiresAt: new Date(Date.now() + durationMs),
      });

      await finishAction(ctx, auth.pluginConfig, "tempban", user, reason, record, `Duration: **${durationStr}**`);
    },
  },
  {
    plugin: "infractions",
    permission: "can_unban",
    discordPermissions: BanMembers,
    data: new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Unban a user")
      .addStringOption((o) => o.setName("user_id").setDescription("User ID to unban").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_unban");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig))) return;

      const userId = ctx.interaction.options.getString("user_id", true);
      const reason = formatReason(ctx.interaction.options.getString("reason"));

      await ctx.interaction.guild!.members.unban(userId, reason);
      await deactivateInfractions(ctx.interaction.guildId!, userId, ["ban", "tempban"]);

      const user = await ctx.client.users.fetch(userId).catch(() => null);
      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId,
        modId: ctx.interaction.user.id,
        type: "unban",
        reason,
        active: false,
      });
      await finishAction(ctx, auth.pluginConfig, "unban", user ?? { id: userId, tag: userId } as import("discord.js").User, reason, record);
    },
  },
  {
    plugin: "infractions",
    permission: "can_softban",
    discordPermissions: BanMembers,
    data: new SlashCommandBuilder()
      .setName("softban")
      .setDescription("Ban and immediately unban to purge messages")
      .addUserOption((o) => o.setName("user").setDescription("Member to softban").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    execute: async (ctx) => {
      const auth = await requireInfractionPermission(ctx, "can_softban");
      if (!auth) return;
      if (!(await requireDiscordPerm(ctx.interaction, BanMembers, "Ban Members", ctx.ephemeral, ctx.guildConfig))) return;

      const user = ctx.interaction.options.getUser("user", true);
      const target = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      const err = canModerateTarget(auth.member, target, user, ctx.interaction.guild!);
      if (err) {
        await ctx.interaction.reply(resultReply("Softban", err, ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      const deleteDays = auth.pluginConfig.softban_delete_message_days;
      const reason = formatReason(ctx.interaction.options.getString("reason"));
      const guild = ctx.interaction.guild!;

      await guild.members.ban(user.id, { deleteMessageSeconds: deleteDays * 86400, reason });
      await guild.members.unban(user.id, "Softban");

      const record = await createInfraction({
        guildId: ctx.interaction.guildId!,
        userId: user.id,
        modId: ctx.interaction.user.id,
        type: "softban",
        reason,
        active: false,
      });
      await finishAction(ctx, auth.pluginConfig, "softban", user, reason, record);
    },
  },
];
