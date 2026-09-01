import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { embedReply } from "../../core/responses.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../core/embeds.js";
import { getPassportUrl } from "../../core/docsUrl.js";
import { zPassportConfig } from "../../config/schemas/passport.js";
import { completePassportVerification } from "./functions/complete.js";
import { postPassportPanel, sendPassportTestPing } from "./functions/delivery.js";
import { applyRevoke } from "./functions/roles.js";
import { deletePassportPending, deletePassportVerification, getPassportPending, getPassportVerification } from "./functions/store.js";

export const passportCommands: SlashCommandDefinition[] = [
  {
    plugin: "passport",
    data: new SlashCommandBuilder()
      .setName("passport")
      .setDescription("Manage Passport verification")
      .addSubcommand((sub) => sub.setName("panel").setDescription("Post a persistent Verify panel"))
      .addSubcommand((sub) => sub.setName("test").setDescription("Send a test verify ping as yourself"))
      .addSubcommand((sub) =>
        sub
          .setName("force")
          .setDescription("Mark a member as verified")
          .addUserOption((o) => o.setName("user").setDescription("Member to verify").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("revoke")
          .setDescription("Revoke a member's verification")
          .addUserOption((o) => o.setName("user").setDescription("Member to revoke").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Check a member's Passport status")
          .addUserOption((o) => o.setName("user").setDescription("Member to look up").setRequired(true)),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guild = ctx.interaction.guild!;
      const perm =
        sub === "panel"
          ? "can_panel"
          : sub === "test"
            ? "can_test"
            : sub === "force"
              ? "can_force"
              : sub === "revoke"
                ? "can_revoke"
                : "can_test";

      const auth = await requirePluginPermission(ctx, "passport", perm);
      if (!auth) return;

      const config = zPassportConfig.parse(auth.pluginConfig);

      if (sub === "panel") {
        const result = await postPassportPanel(guild, config, auth.member);
        await ctx.interaction.reply(
          resultReply(
            result.ok ? "Panel posted" : "Couldn't post panel",
            result.detail,
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: result.ok ? "success" : "error",
              ...(result.ok ? { emoji: "<:icons_announce:1544417473410105378>" } : {}),
            }),
          ),
        );
        return;
      }

      if (sub === "test") {
        const result = await sendPassportTestPing(auth.member, config);
        await ctx.interaction.reply(
          resultReply(
            result.ok ? "Test sent" : "Couldn't send test",
            result.detail,
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: result.ok ? "success" : "error",
              ...(result.ok ? { emoji: "<:icons_ping:1544417376328491008>" } : {}),
            }),
          ),
        );
        return;
      }

      const user = ctx.interaction.options.getUser("user", true);
      const member = await guild.members.fetch(user.id).catch(() => null);

      if (sub === "status") {
        const pending = await getPassportPending(guild.id, user.id);
        const verified = await getPassportVerification(guild.id, user.id);
        const embed = setEmbedAuthor(
          baseEmbed(),
          "Passport status",
          ctx.client,
          commandHeader(ctx.guildConfig, { emoji: "<:icons_id:1544417556868104274>" }),
        ).addFields(
          embedField("Member", `${user} \`${user.id}\``, false),
          embedField(
            "Verified",
            verified
              ? `<t:${Math.floor(verified.verifiedAt.getTime() / 1000)}:R> (${verified.method})`
              : "No",
            true,
          ),
          embedField("Pending", pending ? "Waiting to verify" : "No", true),
          embedField("Page", getPassportUrl(guild.id), false),
        );
        await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
        return;
      }

      if (!member) {
        await ctx.interaction.reply(
          resultReply(
            "Not in server",
            "That user isn't in this server.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: "warning" }),
          ),
        );
        return;
      }

      if (sub === "force") {
        const already = Boolean(await getPassportVerification(guild.id, member.id));
        const result = await completePassportVerification({
          client: ctx.client,
          member,
          guildConfig: ctx.guildConfig,
          config,
          method: "force",
          alreadyVerified: already,
        });
        await ctx.interaction.reply(
          resultReply(
            result.ok ? "Verified" : "Couldn't verify",
            result.ok
              ? `${member} is now verified.`
              : result.error,
            ctx.ephemeral,
            slashResultOptions(ctx, {
              tone: result.ok ? "success" : "error",
              ...(result.ok ? { emoji: "<:icons_verified:1544417456922304534>" } : {}),
            }),
          ),
        );
        return;
      }

      await applyRevoke(member, config);
      await deletePassportVerification(guild.id, member.id);
      await deletePassportPending(guild.id, member.id);
      await ctx.interaction.reply(
        resultReply(
          "Revoked",
          `${member} is no longer verified.`,
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: "success", emoji: "<:icons_linkrevoke:1544417799445676062>" }),
        ),
      );
    },
  },
];
