import { Events, type Client, type Guild, type GuildMember, type Message, type PartialGuildMember } from "discord.js";
import { zTeamControlConfig } from "../../config/schemas/teamControl.js";
import { getLogger } from "../../core/logger.js";
import { definePlugin } from "../../core/plugin.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { teamControlCommands, teamControlContextMenus } from "./commands.js";
import { PLUGIN } from "./functions/config.js";
import { forgetGuildConfirmations } from "./functions/interactions.js";
import { handleTeamMemberRemove, loadTeamRuntime, syncMember } from "./functions/members.js";
import { forgetOneStatus } from "./functions/oneGate.js";
import { forgetRosterGuild, initRoster, scheduleRosterUpdate } from "./functions/roster.js";
import { countStaffMessage, forgetGuildMessages, runTeamSweep, runTeamTick, SWEEP_MS, TICK_MS } from "./functions/tasks.js";

const log = getLogger("team_control");

export const teamControlPlugin = definePlugin({
  name: PLUGIN,
  configSchema: zTeamControlConfig,
  slashCommands: teamControlCommands,
  contextMenuCommands: teamControlContextMenus,
  onLoad: async ({ client, configManager }) => {
    initRoster(client, async (guildId) => (await loadTeamRuntime(guildId))?.config ?? null);
    // A saved config (new ranks, a roster channel) shows on the roster straight away.
    configManager.onSave((guildId) => scheduleRosterUpdate(guildId));
    registerIntervalTask({ id: "team-control:tick", intervalMs: TICK_MS, run: runTeamTick });
    registerIntervalTask({ id: "team-control:sweep", intervalMs: SWEEP_MS, run: runTeamSweep });
  },
  events: [
    {
      name: Events.ClientReady,
      once: true,
      execute: async (client) => {
        // Restart catch-up: anything that came due while the bot was offline runs now, and the
        // first sweep runs a few minutes after boot instead of 30 minutes later.
        await runTeamTick(client as Client).catch((error) => log.error("Team Control catch-up tick failed:", error));
        setTimeout(() => void runTeamSweep(client as Client).catch((error) => log.error("Team Control first sweep failed:", error)), 3 * 60_000).unref?.();
      },
    },
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const before = oldMember as GuildMember | PartialGuildMember;
        const after = newMember as GuildMember;
        if (!before.partial && before.roles.cache.size === after.roles.cache.size && before.roles.cache.every((_r, id) => after.roles.cache.has(id))) return;
        const runtime = await loadTeamRuntime(after.guild.id);
        if (!runtime || runtime.config.ranks.length === 0) return;
        await syncMember(after, runtime.config);
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as GuildMember;
        const runtime = await loadTeamRuntime(m.guild.id);
        if (!runtime || runtime.config.ranks.length === 0) return;
        await syncMember(m, runtime.config);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        await handleTeamMemberRemove(member as GuildMember | PartialGuildMember);
      },
    },
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        await countStaffMessage(message as Message);
      },
    },
    {
      name: Events.GuildDelete,
      execute: async (_client, guild: unknown) => {
        const id = (guild as Guild).id;
        forgetRosterGuild(id);
        forgetGuildConfirmations(id);
        forgetGuildMessages(id);
        forgetOneStatus(id);
      },
    },
  ],
});
