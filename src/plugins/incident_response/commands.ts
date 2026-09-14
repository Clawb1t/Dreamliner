import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import type { Translator } from "../../i18n/index.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { getIncident, listIncidents, setIncidentStatus } from "./functions/store.js";
import { unlockChannelManually } from "./functions/lockdown.js";

const SEVERITY_EMOJI: Record<string, string> = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };

function entityMention(entityType: string, entityId: string, t: Translator): string {
  if (entityType === "user") return `<@${entityId}>`;
  if (entityType === "channel") return `<#${entityId}>`;
  return t("incident_response.thisServer", "this server");
}

export const incidentResponseCommands: SlashCommandDefinition[] = [
  {
    plugin: "incident_response",
    data: new SlashCommandBuilder()
      .setName("incident")
      .setDescription("Review and manage Incident Response incidents")
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List open incidents")
          .addStringOption((o) =>
            o
              .setName("status")
              .setDescription("Filter by status")
              .addChoices(
                { name: "Open", value: "open" },
                { name: "Acknowledged", value: "acknowledged" },
                { name: "Resolved", value: "resolved" },
                { name: "Dismissed", value: "dismissed" },
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("view")
          .setDescription("View one incident in detail")
          .addIntegerOption((o) => o.setName("id").setDescription("Incident id").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("resolve")
          .setDescription("Mark an incident resolved (action taken)")
          .addIntegerOption((o) => o.setName("id").setDescription("Incident id").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("dismiss")
          .setDescription("Mark an incident dismissed (false positive)")
          .addIntegerOption((o) => o.setName("id").setDescription("Incident id").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("unlock")
          .setDescription("Manually unlock a channel Incident Response locked")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel to unlock")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum)
              .setRequired(true),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      const auth = await requirePluginPermission(ctx, "incident_response", "can_manage");
      if (!auth) return;

      if (sub === "list") {
        const status = ctx.interaction.options.getString("status") ?? "open";
        const { incidents, total } = await listIncidents(guildId, { status: status as never, limit: 15 });
        if (!incidents.length) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("incident_response.incidentsTitle", "Incidents"),
              ctx.t("incident_response.noStatusIncidents", "No {status} incidents.", { status }),
              ctx.ephemeral,
              slashResultOptions(ctx),
            ),
          );
          return;
        }
        const lines = incidents.map(
          (i) =>
            `${SEVERITY_EMOJI[i.severity] ?? "⚪"} \`#${i.id}\` ${entityMention(i.entityType, i.entityId, ctx.t)} — **${i.title}** ` +
            `(${ctx.t("incident_response.riskSignalCount", "risk {risk}, {count} signal{plural}", { risk: i.riskScore, count: i.signalCount, plural: i.signalCount === 1 ? "" : "s" })})`,
        );
        await ctx.interaction.reply(
          resultReply(
            ctx.t("incident_response.statusIncidentsTitle", "{status} incidents ({total})", {
              status: `${status[0]!.toUpperCase()}${status.slice(1)}`,
              total,
            }),
            lines.join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "view") {
        const id = ctx.interaction.options.getInteger("id", true);
        const incident = await getIncident(guildId, id);
        if (!incident) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("incident_response.notFoundTitle", "Not found"),
              ctx.t("incident_response.noIncidentWithId", "No incident with that id."),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }
        const lines = [
          ctx.t("incident_response.entityLine", "Entity: {entity}", { entity: entityMention(incident.entityType, incident.entityId, ctx.t) }),
          ctx.t("incident_response.severityLine", "Severity: {emoji} **{severity}** (risk {risk})", {
            emoji: SEVERITY_EMOJI[incident.severity] ?? "",
            severity: incident.severity,
            risk: incident.riskScore,
          }),
          ctx.t("incident_response.statusLine", "Status: **{status}**", { status: incident.status }),
          ctx.t("incident_response.signalsLine", "Signals: {count} across {sources} source{plural}", {
            count: incident.signalCount,
            sources: incident.sourceCount,
            plural: incident.sourceCount === 1 ? "" : "s",
          }),
          incident.actionsTaken.length
            ? ctx.t("incident_response.actionsTakenLine", "Actions taken: {actions}", { actions: incident.actionsTaken.join(", ") })
            : null,
          ctx.t("incident_response.openedLine", "Opened: <t:{ts}:R>", { ts: Math.floor(incident.firstSignalAt.getTime() / 1000) }),
        ].filter((l): l is string => Boolean(l));
        await ctx.interaction.reply(
          resultReply(
            ctx.t("incident_response.incidentTitle", "Incident #{id} — {title}", { id: incident.id, title: incident.title }),
            lines.join("\n"),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "resolve" || sub === "dismiss") {
        const id = ctx.interaction.options.getInteger("id", true);
        const incident = await setIncidentStatus(guildId, id, sub === "resolve" ? "resolved" : "dismissed", ctx.interaction.user.id);
        await ctx.interaction.reply(
          resultReply(
            incident ? ctx.t("incident_response.updatedTitle", "Updated") : ctx.t("incident_response.notFoundTitle", "Not found"),
            incident
              ? sub === "resolve"
                ? ctx.t("incident_response.incidentMarkedResolved", "Incident #{id} marked resolved.", { id })
                : ctx.t("incident_response.incidentMarkedDismissed", "Incident #{id} marked dismissed.", { id })
              : ctx.t("incident_response.noIncidentWithId", "No incident with that id."),
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: incident ? undefined : "warning" }),
          ),
        );
        return;
      }

      // sub === "unlock"
      const channel = ctx.interaction.options.getChannel("channel", true);
      const result = await unlockChannelManually(ctx.interaction.guild!, channel.id, ctx.interaction.user.id, ctx.t);
      await ctx.interaction.reply(
        resultReply(
          result.ok ? ctx.t("incident_response.unlockedTitle", "Unlocked") : ctx.t("incident_response.notLockedTitle", "Not locked"),
          result.ok
            ? ctx.t("incident_response.channelUnlocked", "<#{channel}> was unlocked.", { channel: channel.id })
            : result.error ?? ctx.t("incident_response.failedToUnlock", "Failed to unlock that channel."),
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: result.ok ? undefined : "warning" }),
        ),
      );
    },
  },
];
