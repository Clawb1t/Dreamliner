import { SlashCommandBuilder, ChannelType } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { getIncident, listIncidents, setIncidentStatus } from "./functions/store.js";
import { unlockChannelManually } from "./functions/lockdown.js";

const SEVERITY_EMOJI: Record<string, string> = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };

function entityMention(entityType: string, entityId: string): string {
  if (entityType === "user") return `<@${entityId}>`;
  if (entityType === "channel") return `<#${entityId}>`;
  return "this server";
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
          await ctx.interaction.reply(resultReply("Incidents", `No ${status} incidents.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }
        const lines = incidents.map(
          (i) =>
            `${SEVERITY_EMOJI[i.severity] ?? "⚪"} \`#${i.id}\` ${entityMention(i.entityType, i.entityId)} — **${i.title}** ` +
            `(risk ${i.riskScore}, ${i.signalCount} signal${i.signalCount === 1 ? "" : "s"})`,
        );
        await ctx.interaction.reply(
          resultReply(`${status[0]!.toUpperCase()}${status.slice(1)} incidents (${total})`, lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "view") {
        const id = ctx.interaction.options.getInteger("id", true);
        const incident = await getIncident(guildId, id);
        if (!incident) {
          await ctx.interaction.reply(resultReply("Not found", "No incident with that id.", ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }
        const lines = [
          `Entity: ${entityMention(incident.entityType, incident.entityId)}`,
          `Severity: ${SEVERITY_EMOJI[incident.severity] ?? ""} **${incident.severity}** (risk ${incident.riskScore})`,
          `Status: **${incident.status}**`,
          `Signals: ${incident.signalCount} across ${incident.sourceCount} source${incident.sourceCount === 1 ? "" : "s"}`,
          incident.actionsTaken.length ? `Actions taken: ${incident.actionsTaken.join(", ")}` : null,
          `Opened: <t:${Math.floor(incident.firstSignalAt.getTime() / 1000)}:R>`,
        ].filter((l): l is string => Boolean(l));
        await ctx.interaction.reply(resultReply(`Incident #${incident.id} — ${incident.title}`, lines.join("\n"), ctx.ephemeral, slashResultOptions(ctx)));
        return;
      }

      if (sub === "resolve" || sub === "dismiss") {
        const id = ctx.interaction.options.getInteger("id", true);
        const incident = await setIncidentStatus(guildId, id, sub === "resolve" ? "resolved" : "dismissed", ctx.interaction.user.id);
        await ctx.interaction.reply(
          resultReply(
            incident ? "Updated" : "Not found",
            incident ? `Incident #${id} marked ${sub === "resolve" ? "resolved" : "dismissed"}.` : "No incident with that id.",
            ctx.ephemeral,
            slashResultOptions(ctx, { tone: incident ? undefined : "warning" }),
          ),
        );
        return;
      }

      // sub === "unlock"
      const channel = ctx.interaction.options.getChannel("channel", true);
      const result = await unlockChannelManually(ctx.interaction.guild!, channel.id, ctx.interaction.user.id);
      await ctx.interaction.reply(
        resultReply(
          result.ok ? "Unlocked" : "Not locked",
          result.ok ? `<#${channel.id}> was unlocked.` : result.error ?? "Failed to unlock that channel.",
          ctx.ephemeral,
          slashResultOptions(ctx, { tone: result.ok ? undefined : "warning" }),
        ),
      );
    },
  },
];
