import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { getModerationLogChannelId } from "../../core/logging/channels.js";
import { fetchImageBuffer } from "../../core/imageFetch.js";
import { parseImpersonationConfig } from "./functions/handlers.js";
import { addWatchlistEntry, listWatchlist, removeWatchlistEntry, ImpersonationWatchlistError } from "./functions/watchlist.js";
import { listAlerts, setAlertStatus, countOpenAlerts } from "./functions/alerts.js";
import { getIdentityHistory } from "./functions/history.js";

function formatStatus(config: ReturnType<typeof parseImpersonationConfig>, guildConfig: Parameters<typeof getModerationLogChannelId>[0]): string {
  const logChannelId = getModerationLogChannelId(guildConfig, config.log_channel_id);
  return [
    `**Protected roles:** ${config.protected_roles.map((id) => `<@&${id}>`).join(", ") || "none"}`,
    `**Compare scope:** ${config.compare_scope === "everyone" ? "Everyone (thorough, slower)" : "Protected roles + watchlist (recommended)"}`,
    `**Checks:** join ${config.check_on_join ? "✓" : "✗"} · username ${config.check_username ? "✓" : "✗"} · display name ${config.check_display_name ? "✓" : "✗"} · nickname ${config.check_nickname ? "✓" : "✗"} · avatar ${config.check_avatar ? "✓" : "✗"}`,
    `**Thresholds:** name similarity ≥ ${config.name_similarity_threshold}% · avatar distance ≤ ${config.avatar_max_distance}`,
    `**Auto action:** ${config.auto_action}`,
    `**Log channel:** ${logChannelId ? `<#${logChannelId}>` : "none (set moderation_log_channel_id)"}`,
  ].join("\n");
}

export const impersonationCommands: SlashCommandDefinition[] = [
  {
    plugin: "impersonation",
    data: new SlashCommandBuilder()
      .setName("impersonation")
      .setDescription("Impersonation Detection status, watchlist, and alerts")
      .addSubcommand((sub) => sub.setName("status").setDescription("Show Impersonation Detection configuration"))
      .addSubcommand((sub) =>
        sub
          .setName("history")
          .setDescription("Show a member's tracked identity history")
          .addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("watchlist")
          .setDescription("Manually protect a specific identity")
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Add an identity to the watchlist")
              .addStringOption((o) => o.setName("label").setDescription("What to call this entry").setRequired(true))
              .addUserOption((o) => o.setName("member").setDescription("Pin a real member (kept live-synced)"))
              .addStringOption((o) => o.setName("name").setDescription("Manual name to protect (no real account)"))
              .addAttachmentOption((o) => o.setName("image").setDescription("Manual avatar image to protect")),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove a watchlist entry")
              .addStringOption((o) => o.setName("id").setDescription("Entry id (from /impersonation watchlist list)").setRequired(true)),
          )
          .addSubcommand((sub) => sub.setName("list").setDescription("List watchlist entries")),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("alerts")
          .setDescription("Review detected impersonation alerts")
          .addSubcommand((sub) => sub.setName("list").setDescription("List open alerts"))
          .addSubcommand((sub) =>
            sub
              .setName("resolve")
              .setDescription("Mark an alert resolved (action taken)")
              .addStringOption((o) => o.setName("id").setDescription("Alert id").setRequired(true)),
          )
          .addSubcommand((sub) =>
            sub
              .setName("dismiss")
              .setDescription("Mark an alert dismissed (false positive)")
              .addStringOption((o) => o.setName("id").setDescription("Alert id").setRequired(true)),
          ),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "status" && !group) {
        const auth = await requirePluginPermission(ctx, "impersonation", "can_status");
        if (!auth) return;
        const config = parseImpersonationConfig(auth.pluginConfig);
        await ctx.interaction.reply(
          resultReply(
            "Impersonation Detection",
            formatStatus(config, ctx.guildConfig),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_summary:1544418222831571044>" }),
          ),
        );
        return;
      }

      if (sub === "history" && !group) {
        const auth = await requirePluginPermission(ctx, "impersonation", "can_status");
        if (!auth) return;
        const member = ctx.interaction.options.getUser("member", true);
        const entries = await getIdentityHistory(guildId, member.id);
        if (!entries.length) {
          await ctx.interaction.reply(
            resultReply("Identity history", `No tracked changes for ${member.tag}.`, ctx.ephemeral, slashResultOptions(ctx)),
          );
          return;
        }
        const lines = entries.map((e) => {
          const when = `<t:${Math.floor(e.changedAt / 1000)}:R>`;
          if (e.field === "joined") return `• ${when} — joined as \`${e.newValue}\``;
          if (e.field === "avatar") return `• ${when} — avatar changed`;
          return `• ${when} — ${e.field}: \`${e.oldValue ?? "(none)"}\` → \`${e.newValue ?? "(none)"}\``;
        });
        await ctx.interaction.reply(
          resultReply(
            `Identity history — ${member.tag}`,
            lines.join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_search:1544417406640726168>" }),
          ),
        );
        return;
      }

      if (group === "watchlist") {
        const auth = await requirePluginPermission(ctx, "impersonation", "can_manage_watchlist");
        if (!auth) return;

        if (sub === "list") {
          const entries = await listWatchlist(guildId);
          if (!entries.length) {
            await ctx.interaction.reply(resultReply("Watchlist", "No watchlist entries.", ctx.ephemeral, slashResultOptions(ctx)));
            return;
          }
          const lines = entries
            .slice(0, 25)
            .map((e) => `• \`${e.id.slice(0, 8)}\` **${e.label}**${e.targetUserId ? ` — <@${e.targetUserId}>` : e.name ? ` — "${e.name}"` : ""}`);
          await ctx.interaction.reply(
            resultReply("Watchlist", lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { emoji: "<:icons_list:1544417562325164173>" })),
          );
          return;
        }

        if (sub === "add") {
          const label = ctx.interaction.options.getString("label", true);
          const target = ctx.interaction.options.getUser("member");
          const name = ctx.interaction.options.getString("name") ?? undefined;
          const image = ctx.interaction.options.getAttachment("image");

          await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
          let imageBuffer: Buffer | undefined;
          if (image) {
            const buf = await fetchImageBuffer(image.url);
            if (!buf) {
              await ctx.interaction.editReply(resultEdit("Error", "Could not download that image.", slashResultOptions(ctx, { tone: "error" })));
              return;
            }
            imageBuffer = buf;
          }
          try {
            const entry = await addWatchlistEntry({
              guildId,
              label,
              addedBy: ctx.interaction.user.id,
              targetUserId: target?.id,
              name,
              imageBuffer,
            });
            await ctx.interaction.editReply(
              resultEdit("Watchlist entry added", `\`${entry.id.slice(0, 8)}\` — **${entry.label}**`, slashResultOptions(ctx, { emoji: "<:icons_enable:1544417874351755264>" })),
            );
          } catch (error) {
            await ctx.interaction.editReply(
              resultEdit("Error", error instanceof ImpersonationWatchlistError ? error.message : "Failed to add entry.", slashResultOptions(ctx, { tone: "error" })),
            );
          }
          return;
        }

        if (sub === "remove") {
          const id = ctx.interaction.options.getString("id", true);
          const ok = await removeWatchlistEntry(guildId, id);
          await ctx.interaction.reply(
            resultReply(
              ok ? "Removed" : "Not found",
              ok ? "Watchlist entry removed." : "No entry with that id (or id prefix isn't unique — use the full id from /impersonation watchlist list).",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: ok ? undefined : "warning" }),
            ),
          );
          return;
        }
      }

      if (group === "alerts") {
        const auth = await requirePluginPermission(ctx, "impersonation", "can_status");
        if (!auth) return;

        if (sub === "list") {
          const [alerts, openCount] = await Promise.all([listAlerts(guildId, { status: "open", limit: 15 }), countOpenAlerts(guildId)]);
          if (!alerts.length) {
            await ctx.interaction.reply(resultReply("Alerts", "No open alerts.", ctx.ephemeral, slashResultOptions(ctx)));
            return;
          }
          const lines = alerts.map(
            (a) =>
              `• \`${a.id.slice(0, 8)}\` <@${a.subjectUserId}> looks like **${a.matchedLabel}**` +
              (a.nameSimilarity ? ` (name ${a.nameSimilarity}%)` : "") +
              (a.avatarDistance != null ? ` (avatar Δ${a.avatarDistance})` : ""),
          );
          await ctx.interaction.reply(
            resultReply(`Open alerts (${openCount})`, lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx, { emoji: "<:icons_warning:1544418156913885194>" })),
          );
          return;
        }

        if (sub === "resolve" || sub === "dismiss") {
          const id = ctx.interaction.options.getString("id", true);
          const alert = await setAlertStatus(guildId, id, sub === "resolve" ? "resolved" : "dismissed", ctx.interaction.user.id);
          await ctx.interaction.reply(
            resultReply(
              alert ? "Updated" : "Not found",
              alert ? `Alert marked ${sub === "resolve" ? "resolved" : "dismissed"}.` : "No alert with that id.",
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: alert ? undefined : "warning" }),
            ),
          );
          return;
        }
      }
    },
  },
];
