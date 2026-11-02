import {
  ActionRowBuilder,
  ApplicationCommandType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type User,
} from "discord.js";
import { buildResultEmbed, guildResultOptions } from "../../core/embeds.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, embedWithFilesEdit, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import type { ContextMenuCommandDefinition, SlashCommandContext, SlashCommandDefinition } from "../../core/types.js";
import type { Translator } from "../../i18n/index.js";
import { getCacheState, warmGuild } from "./functions/cache.js";
import { formatCount, MAX_TRACKED_LINKS, PLUGIN, RESET_ALL_BUTTON, type InviteCounts } from "./functions/config.js";
import { renderInviteLeaderboard } from "./functions/leaderboard.js";
import { invitesPausedUntil, pauseInvites, resumeInvites } from "./functions/raidActions.js";
import { clampPauseMinutes } from "./functions/raid.js";
import {
  addBonus,
  getCounts,
  getLatestJoin,
  getRank,
  getTrackedLinksById,
  listInvitedBy,
  listTrackedLinks,
  parseRoleIds,
  resetMemberCounts,
  trackedLinkStats,
  type InviteJoin,
} from "./functions/store.js";
import { createTrackedLink, deleteTrackedLink, trackedLinkUrl } from "./functions/trackedLinks.js";

const INVITED_PAGE_SIZE = 10;

type Tone = "neutral" | "success" | "warning" | "error";

async function reply(ctx: SlashCommandContext, title: string, body: string, tone: Tone = "neutral"): Promise<void> {
  await ctx.interaction.reply(resultReply(title, body, ctx.ephemeral, slashResultOptions(ctx, { tone })));
}

export function countsSummary(t: Translator, counts: InviteCounts): string {
  return t(
    "invite_tracker.countsSummary",
    "**{total}** invites (**{regular}** regular, **{left}** left, **{fake}** fake, **{bonus}** bonus)",
    {
      total: formatCount(counts.total),
      regular: formatCount(counts.regular),
      left: formatCount(counts.left),
      fake: formatCount(counts.fake),
      bonus: formatCount(counts.bonus),
    },
  );
}

/** "valid", "left", "fake (account age)", "pending verification" for one join row. */
export function joinStatusLabel(t: Translator, join: Pick<InviteJoin, "status" | "fakeReason" | "leftAt">): string {
  if (join.status === "pending") return t("invite_tracker.statusPending", "waiting on verification");
  if (join.status === "fake") {
    return t("invite_tracker.statusFake", "fake ({reason})", { reason: (join.fakeReason ?? "unknown").replace(/_/g, " ") });
  }
  return join.leftAt ? t("invite_tracker.statusLeft", "left") : t("invite_tracker.statusValid", "in the server");
}

function sourceLabel(t: Translator, join: Pick<InviteJoin, "source" | "code" | "inviterId">, linkName: string | null): string {
  switch (join.source) {
    case "invite":
      return join.inviterId
        ? t("invite_tracker.sourceInvite", "<@{id}>'s invite `{code}`", { id: join.inviterId, code: join.code ?? "?" })
        : t("invite_tracker.sourceInviteNoOwner", "invite `{code}`", { code: join.code ?? "?" });
    case "tracked":
      return t("invite_tracker.sourceTracked", "tracked link **{name}**", { name: linkName ?? join.code ?? "?" });
    case "vanity":
      return t("invite_tracker.sourceVanity", "the vanity URL");
    case "oauth":
      return t("invite_tracker.sourceOauth", "a bot invite");
    default:
      return t("invite_tracker.sourceUnknown", "an unknown invite");
  }
}

/** Who invited a member, as reply text (shared by /invites who and the context menu). */
export function whoInvitedText(t: Translator, guild: Guild, user: User): string {
  const join = getLatestJoin(guild.id, user.id);
  if (!join) {
    return t("invite_tracker.whoNoRecord", "I don't know how <@{id}> joined. They joined before tracking started.", { id: user.id });
  }
  const link = join.trackedLinkId ? getTrackedLinksById(guild.id, [join.trackedLinkId]).get(join.trackedLinkId) : null;
  const lines = [
    t("invite_tracker.whoJoinedVia", "<@{id}> joined via {source} <t:{time}:R>.", {
      id: user.id,
      source: sourceLabel(t, join, link?.name ?? null),
      time: Math.floor(join.joinedAt.getTime() / 1000),
    }),
    t("invite_tracker.whoStatus", "Status: {status}", { status: joinStatusLabel(t, join) }),
  ];
  if (join.inviterId) {
    lines.push(
      t("invite_tracker.whoInviterNow", "<@{id}> now has {summary}.", {
        id: join.inviterId,
        summary: countsSummary(t, getCounts(guild.id, join.inviterId)),
      }),
    );
  }
  return lines.join("\n");
}

/** Resolves the optional `user` option, checking can_view_others when it's someone else. */
async function resolveViewTarget(ctx: SlashCommandContext, optionName = "user", required = false): Promise<User | null> {
  const auth = await requirePluginPermission(ctx, PLUGIN, "can_view");
  if (!auth) return null;
  const user = ctx.interaction.options.getUser(optionName, required) ?? ctx.interaction.user;
  if (user.id !== ctx.interaction.user.id) {
    const others = await requirePluginPermission(ctx, PLUGIN, "can_view_others");
    if (!others) return null;
  }
  return user;
}

function missingManageServerNote(t: Translator, guild: Guild): string {
  return getCacheState(guild.id).warm && !getCacheState(guild.id).permOk
    ? `\n\n${t("invite_tracker.missingManageServer", "⚠️ Missing Manage Server: Dreamliner can't read this server's invites, so new joins can't be attributed.")}`
    : "";
}

export const inviteTrackerCommands: SlashCommandDefinition[] = [
  {
    plugin: PLUGIN,
    data: new SlashCommandBuilder()
      .setName("invites")
      .setDescription("Invite tracking: counts, leaderboard, tracked links and raid pausing")
      .addSubcommand((sub) =>
        sub
          .setName("count")
          .setDescription("How many people someone has invited")
          .addUserOption((o) => o.setName("user").setDescription("Member to check (defaults to you)")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("leaderboard")
          .setDescription("Top inviters")
          .addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1).setMaxValue(1000)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("who")
          .setDescription("Who invited a member")
          .addUserOption((o) => o.setName("user").setDescription("Member to look up").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("invited")
          .setDescription("The members someone invited")
          .addUserOption((o) => o.setName("user").setDescription("Inviter (defaults to you)"))
          .addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1).setMaxValue(1000)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("codes")
          .setDescription("Someone's active invite codes")
          .addUserOption((o) => o.setName("user").setDescription("Member to check (defaults to you)")),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("bonus")
          .setDescription("Adjust a member's invites by hand")
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Add bonus invites")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
              .addIntegerOption((o) => o.setName("amount").setDescription("How many").setRequired(true).setMinValue(1).setMaxValue(10_000)),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove invites")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
              .addIntegerOption((o) => o.setName("amount").setDescription("How many").setRequired(true).setMinValue(1).setMaxValue(10_000)),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("reset")
          .setDescription("Reset invite counts (join history is kept)")
          .addSubcommand((sub) =>
            sub
              .setName("user")
              .setDescription("Reset one member's invites")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
          )
          .addSubcommand((sub) => sub.setName("all").setDescription("Reset everyone's invites")),
      )
      .addSubcommand((sub) => sub.setName("sync").setDescription("Re-read this server's invites from Discord"))
      .addSubcommandGroup((group) =>
        group
          .setName("links")
          .setDescription("Tracked links: invites that record where members came from")
          .addSubcommand((sub) => sub.setName("list").setDescription("List tracked links and their joins"))
          .addSubcommand((sub) =>
            sub
              .setName("create")
              .setDescription("Create a tracked link")
              .addStringOption((o) => o.setName("name").setDescription("What the link is for, e.g. Twitter bio").setRequired(true).setMaxLength(50))
              .addChannelOption((o) =>
                o
                  .setName("channel")
                  .setDescription("Channel the invite opens")
                  .setRequired(true)
                  .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum),
              )
              .addRoleOption((o) => o.setName("role").setDescription("Role to give members who join through it"))
              .addIntegerOption((o) => o.setName("max_uses").setDescription("0 = unlimited").setMinValue(0).setMaxValue(100)),
          )
          .addSubcommand((sub) =>
            sub
              .setName("delete")
              .setDescription("Delete a tracked link (its stats are kept)")
              .addIntegerOption((o) => o.setName("link").setDescription("Link ID from /invites links list").setRequired(true).setMinValue(1)),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("raid")
          .setDescription("Pause or resume every invite to this server")
          .addSubcommand((sub) =>
            sub
              .setName("pause")
              .setDescription("Pause every invite")
              .addIntegerOption((o) => o.setName("minutes").setDescription("How long (15 to 1440, default 60)").setMinValue(15).setMaxValue(1440)),
          )
          .addSubcommand((sub) => sub.setName("resume").setDescription("Resume invites now"))
          .addSubcommand((sub) => sub.setName("status").setDescription("Whether invites are paused")),
      ),
    execute: async (ctx) => {
      const { t, interaction } = ctx;
      const guild = interaction.guild;
      if (!guild) {
        await requirePluginPermission(ctx, PLUGIN, "can_view");
        return;
      }
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      const title = t("invite_tracker.title", "Invites");

      if (!group && sub === "count") {
        const user = await resolveViewTarget(ctx);
        if (!user) return;
        const counts = getCounts(guild.id, user.id);
        const rank = getRank(guild.id, user.id);
        const rankText = rank ? ` · #${rank}` : "";
        await reply(ctx, title, `<@${user.id}>${rankText}\n${countsSummary(t, counts)}${missingManageServerNote(t, guild)}`);
        return;
      }

      if (!group && sub === "leaderboard") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_view");
        if (!auth) return;
        await interaction.deferReply(deferReplyOptions(ctx.ephemeral));
        const image = await renderInviteLeaderboard(guild, interaction.options.getInteger("page") ?? 1, t);
        if (!image) {
          await interaction.editReply(resultEdit(title, t("invite_tracker.noInvites", "Nobody has invited anyone yet."), slashResultOptions(ctx)));
          return;
        }
        const filename = "invites-leaderboard.png";
        await interaction.editReply(
          embedWithFilesEdit(
            buildResultEmbed(
              t("invite_tracker.leaderboardTitle", "Top inviters"),
              t("invite_tracker.leaderboardCaption", "Page {page} of {pages}", { page: image.page, pages: image.pages }),
              slashResultOptions(ctx, { imageURL: `attachment://${filename}` }),
            ),
            [new AttachmentBuilder(image.buffer, { name: filename })],
          ),
        );
        return;
      }

      if (!group && sub === "who") {
        const user = await resolveViewTarget(ctx, "user", true);
        if (!user) return;
        await reply(ctx, t("invite_tracker.whoTitle", "Who invited"), whoInvitedText(t, guild, user));
        return;
      }

      if (!group && sub === "invited") {
        const user = await resolveViewTarget(ctx);
        if (!user) return;
        const page = Math.max(1, interaction.options.getInteger("page") ?? 1);
        const { rows, total } = listInvitedBy(guild.id, user.id, INVITED_PAGE_SIZE, (page - 1) * INVITED_PAGE_SIZE);
        if (total === 0) {
          await reply(ctx, title, t("invite_tracker.invitedNone", "<@{id}> hasn't invited anyone yet.", { id: user.id }));
          return;
        }
        const pages = Math.max(1, Math.ceil(total / INVITED_PAGE_SIZE));
        const lines = rows.map(
          (row) => `<@${row.memberId}> · ${joinStatusLabel(t, row)} · <t:${Math.floor(row.joinedAt.getTime() / 1000)}:R>`,
        );
        const footer = t("invite_tracker.invitedFooter", "Page {page} of {pages} · {total} joins", { page, pages, total });
        await reply(
          ctx,
          t("invite_tracker.invitedTitle", "Invited by {name}", { name: user.username }),
          `${lines.join("\n") || t("invite_tracker.pageEmpty", "Nothing on this page.")}\n\n${footer}`,
        );
        return;
      }

      if (!group && sub === "codes") {
        const user = await resolveViewTarget(ctx);
        if (!user) return;
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await reply(ctx, title, t("invite_tracker.needManageServer", "Dreamliner needs Manage Server to read this server's invites."), "warning");
          return;
        }
        const invites = await guild.invites.fetch({ cache: false }).catch(() => null);
        const mine = [...(invites?.values() ?? [])].filter((invite) => invite.inviterId === user.id);
        if (mine.length === 0) {
          await reply(ctx, title, t("invite_tracker.codesNone", "<@{id}> has no active invites.", { id: user.id }));
          return;
        }
        const lines = mine.slice(0, 25).map((invite) => {
          const uses = invite.maxUses ? `${invite.uses ?? 0}/${invite.maxUses}` : `${invite.uses ?? 0}`;
          const expires = invite.expiresTimestamp
            ? t("invite_tracker.codeExpires", "expires <t:{time}:R>", { time: Math.floor(invite.expiresTimestamp / 1000) })
            : t("invite_tracker.codeNeverExpires", "never expires");
          return `\`${invite.code}\` · ${t("invite_tracker.codeUses", "{uses} uses", { uses })} · ${invite.channelId ? `<#${invite.channelId}>` : "?"} · ${expires}`;
        });
        await reply(ctx, t("invite_tracker.codesTitle", "Invite codes"), `<@${user.id}>\n${lines.join("\n")}`);
        return;
      }

      if (group === "bonus") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        const user = interaction.options.getUser("user", true);
        // Bonus invites on yourself take Manage Server, like other self-adjustments.
        if (user.id === auth.member.id && !auth.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await reply(ctx, title, t("invite_tracker.noSelfBonus", "You can't adjust your own invites."), "warning");
          return;
        }
        const amount = interaction.options.getInteger("amount", true) * (sub === "remove" ? -1 : 1);
        addBonus(guild.id, user.id, amount);
        await reply(
          ctx,
          t("invite_tracker.bonusTitle", "Invites adjusted"),
          t("invite_tracker.bonusBody", "<@{id}> now has {summary}.", { id: user.id, summary: countsSummary(t, getCounts(guild.id, user.id)) }),
          "success",
        );
        return;
      }

      if (group === "reset") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        if (sub === "user") {
          const user = interaction.options.getUser("user", true);
          resetMemberCounts(guild.id, user.id);
          await reply(
            ctx,
            t("invite_tracker.resetTitle", "Invites reset"),
            t("invite_tracker.resetUserBody", "Reset <@{id}>'s invites. Their join history is kept.", { id: user.id }),
            "success",
          );
          return;
        }
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${RESET_ALL_BUTTON}:${auth.member.id}`)
            .setLabel(t("invite_tracker.resetAllConfirm", "Reset everyone"))
            .setStyle(ButtonStyle.Danger),
        );
        await interaction.reply(
          resultReply(
            t("invite_tracker.resetAllTitle", "Reset every member's invites?"),
            t(
              "invite_tracker.resetAllBody",
              "Everyone's invite counts and bonuses go back to zero. Join history and analytics are kept. This can't be undone.",
            ),
            true,
            slashResultOptions(ctx, { tone: "warning" }),
            [row],
          ),
        );
        return;
      }

      if (!group && sub === "sync") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        await interaction.deferReply(deferReplyOptions(ctx.ephemeral));
        await warmGuild(guild);
        const state = getCacheState(guild.id);
        await interaction.editReply(
          resultEdit(
            t("invite_tracker.syncTitle", "Invites synced"),
            state.permOk
              ? t("invite_tracker.syncBody", "Read **{count}** invites from Discord.", { count: state.inviteCount })
              : t("invite_tracker.needManageServer", "Dreamliner needs Manage Server to read this server's invites."),
            slashResultOptions(ctx, { tone: state.permOk ? "success" : "warning" }),
          ),
        );
        return;
      }

      if (group === "links") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_manage");
        if (!auth) return;
        if (sub === "list") {
          const links = listTrackedLinks(guild.id);
          if (links.length === 0) {
            await reply(ctx, t("invite_tracker.linksTitle", "Tracked links"), t("invite_tracker.linksNone", "No tracked links yet. Create one with `/invites links create`."));
            return;
          }
          const stats = trackedLinkStats(guild.id);
          const lines = links.slice(0, 25).map((link) => {
            const s = stats.get(link.id) ?? { joins: 0, stayed: 0, left: 0, fake: 0 };
            const roles = parseRoleIds(link.roleIds).map((id) => `<@&${id}>`).join(", ");
            return t("invite_tracker.linkLine", "`#{id}` **{name}** · {url} · {joins} joins, {stayed} stayed{roles}", {
              id: link.id,
              name: link.name,
              url: trackedLinkUrl(link.code),
              joins: s.joins,
              stayed: s.stayed,
              roles: roles ? ` · ${roles}` : "",
            });
          });
          await reply(ctx, t("invite_tracker.linksTitle", "Tracked links"), `${lines.join("\n")}\n\n${links.length}/${MAX_TRACKED_LINKS}`);
          return;
        }
        if (sub === "create") {
          await interaction.deferReply(deferReplyOptions(ctx.ephemeral));
          const role = interaction.options.getRole("role");
          const result = await createTrackedLink(guild, {
            name: interaction.options.getString("name", true),
            channelId: interaction.options.getChannel("channel", true).id,
            roleIds: role ? [role.id] : [],
            maxUses: interaction.options.getInteger("max_uses") ?? 0,
            maxAgeSeconds: 0,
            createdBy: auth.member.id,
          });
          await interaction.editReply(
            result.ok
              ? resultEdit(
                  t("invite_tracker.linkCreatedTitle", "Tracked link created"),
                  t("invite_tracker.linkCreatedBody", "**{name}**: {url}", { name: result.link.name, url: trackedLinkUrl(result.link.code) }),
                  slashResultOptions(ctx, { tone: "success" }),
                )
              : resultEdit(t("invite_tracker.linkFailedTitle", "Couldn't create the link"), result.error, slashResultOptions(ctx, { tone: "error" })),
          );
          return;
        }
        const result = await deleteTrackedLink(guild, interaction.options.getInteger("link", true));
        await reply(
          ctx,
          t("invite_tracker.linksTitle", "Tracked links"),
          result.ok ? t("invite_tracker.linkDeleted", "Deleted the link. Its stats are kept.") : result.error,
          result.ok ? "success" : "warning",
        );
        return;
      }

      if (group === "raid") {
        const auth = await requirePluginPermission(ctx, PLUGIN, "can_raid");
        if (!auth) return;
        const raidTitle = t("invite_tracker.raidTitle", "Invite pause");
        if (sub === "status") {
          const until = invitesPausedUntil(guild);
          await reply(
            ctx,
            raidTitle,
            until
              ? t("invite_tracker.raidPausedUntil", "Invites are paused until <t:{time}:f> (<t:{time}:R>).", { time: Math.floor(until.getTime() / 1000) })
              : t("invite_tracker.raidNotPaused", "Invites aren't paused."),
          );
          return;
        }
        if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await reply(ctx, raidTitle, t("invite_tracker.needManageServerPause", "Dreamliner needs Manage Server to pause invites."), "warning");
          return;
        }
        if (sub === "pause") {
          const minutes = clampPauseMinutes(interaction.options.getInteger("minutes") ?? 60);
          const until = await pauseInvites(guild, minutes);
          await reply(
            ctx,
            raidTitle,
            t("invite_tracker.raidPaused", "Paused every invite until <t:{time}:f>.", { time: Math.floor(until.getTime() / 1000) }),
            "success",
          );
          return;
        }
        await resumeInvites(guild);
        await reply(ctx, raidTitle, t("invite_tracker.raidResumed", "Invites are open again."), "success");
        return;
      }
    },
  },
];

export const inviteTrackerContextMenus: ContextMenuCommandDefinition[] = [
  {
    plugin: PLUGIN,
    permission: "can_view_others",
    data: new ContextMenuCommandBuilder().setName("Who invited").setType(ApplicationCommandType.User),
    execute: async (ctx) => {
      const { interaction, t } = ctx;
      if (!interaction.isUserContextMenuCommand() || !interaction.guild) return;
      await interaction.reply(
        resultReply(
          t("invite_tracker.whoTitle", "Who invited"),
          whoInvitedText(t, interaction.guild, interaction.targetUser),
          true,
          guildResultOptions(ctx.client, ctx.guildConfig),
        ),
      );
    },
  },
];
