import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import { fetchGuildChannel } from "../../../core/guildChannel.js";
import { getLogger } from "../../../core/logger.js";
import { autoGrantableRoleIds } from "../../../core/roles.js";
import { getCacheState, onInviteCreated, onInviteDeleted } from "./cache.js";
import { MAX_LINK_ROLES, MAX_TRACKED_LINKS, TRACKED_LINK_REASON } from "./config.js";
import {
  countActiveLinks,
  getTrackedLink,
  insertTrackedLink,
  parseRoleIds,
  softDeleteTrackedLink,
  type TrackedLinkRow,
} from "./store.js";

const log = getLogger("invite_tracker");
const ROLE_REASON = "Invite Tracker: joined through a tracked link";

/** Channel types Discord can create an invite for. */
const INVITABLE_CHANNELS = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

export const MAX_LINK_AGE_SECONDS = 604_800;
export const MIN_LINK_AGE_SECONDS = 1800;
export const MAX_LINK_USES = 100;

export type CreateTrackedLinkInput = {
  name: string;
  channelId: string;
  roleIds: string[];
  maxUses: number;
  maxAgeSeconds: number;
  createdBy: string | null;
};

export type TrackedLinkResult = { ok: true; link: TrackedLinkRow } | { ok: false; error: string };

/** Checks a create request's shape, returning the first problem in plain words. */
export function validateLinkInput(input: CreateTrackedLinkInput): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 50) return "Link names are 1 to 50 characters.";
  if (!/^\d{17,20}$/.test(input.channelId)) return "Pick a channel for the link.";
  if (input.roleIds.length > MAX_LINK_ROLES) return `A link can give at most ${MAX_LINK_ROLES} roles.`;
  if (!Number.isInteger(input.maxUses) || input.maxUses < 0 || input.maxUses > MAX_LINK_USES) {
    return `Max uses is 0 (unlimited) to ${MAX_LINK_USES}.`;
  }
  const age = input.maxAgeSeconds;
  if (!Number.isInteger(age) || (age !== 0 && (age < MIN_LINK_AGE_SECONDS || age > MAX_LINK_AGE_SECONDS))) {
    return "Expiry is never, or between 30 minutes and 7 days.";
  }
  return null;
}

/**
 * Creates a tracked link: a real Discord invite made by the bot (so it credits no one) whose
 * joins are recorded against the link, and which can give the joining member roles.
 */
export async function createTrackedLink(guild: Guild, input: CreateTrackedLinkInput): Promise<TrackedLinkResult> {
  const problem = validateLinkInput(input);
  if (problem) return { ok: false, error: problem };
  if (countActiveLinks(guild.id) >= MAX_TRACKED_LINKS) {
    return { ok: false, error: `This server already has ${MAX_TRACKED_LINKS} tracked links. Delete one first.` };
  }

  const channel = await fetchGuildChannel(guild.client, guild.id, input.channelId);
  if (!channel || channel.isDMBased() || !INVITABLE_CHANNELS.has(channel.type) || !("createInvite" in channel)) {
    return { ok: false, error: "That channel doesn't exist or can't have invites." };
  }
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
    return { ok: false, error: `Dreamliner needs the Create Invite permission in <#${channel.id}>.` };
  }

  const roleIds = [...new Set(input.roleIds)];
  const grantable = new Set(autoGrantableRoleIds(guild, roleIds));
  const blocked = roleIds.find((id) => !grantable.has(id));
  if (blocked) {
    return {
      ok: false,
      error: `Dreamliner can't give <@&${blocked}>: it must exist, sit below Dreamliner's highest role, and have no staff permissions.`,
    };
  }

  const invite = await channel
    .createInvite({ maxUses: input.maxUses, maxAge: input.maxAgeSeconds, unique: true, reason: TRACKED_LINK_REASON })
    .catch((error: unknown) => {
      log.warn(`Could not create a tracked link in ${guild.id}: ${error instanceof Error ? error.message : error}`);
      return null;
    });
  if (!invite) return { ok: false, error: "Discord refused to create the invite. Check Dreamliner's permissions in that channel." };
  onInviteCreated(guild.id, invite);

  const link = insertTrackedLink({
    guildId: guild.id,
    code: invite.code,
    name: input.name.trim(),
    channelId: channel.id,
    roleIds,
    maxUses: input.maxUses,
    maxAge: input.maxAgeSeconds,
    createdBy: input.createdBy,
  });
  return { ok: true, link };
}

/** Soft-deletes the link (its stats stay) and deletes the Discord invite behind it. */
export async function deleteTrackedLink(guild: Guild, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const link = getTrackedLink(guild.id, id);
  if (!link || link.deletedAt) return { ok: false, error: "That tracked link doesn't exist." };
  softDeleteTrackedLink(guild.id, id);
  await guild.invites.delete(link.code, TRACKED_LINK_REASON).catch(() => null);
  onInviteDeleted(guild.id, link.code);
  return { ok: true };
}

export function trackedLinkUrl(code: string): string {
  return `https://discord.gg/${code}`;
}

/** Whether the link still works: not deleted, not expired, and (when known) still on Discord. */
export function isLinkActive(guild: Guild, link: TrackedLinkRow, liveCodes: ReadonlySet<string> | null, now = Date.now()): boolean {
  if (link.deletedAt) return false;
  if (link.maxAge > 0 && link.createdAt.getTime() + link.maxAge * 1000 <= now) return false;
  if (liveCodes && getCacheState(guild.id).permOk) return liveCodes.has(link.code);
  return true;
}

/** Gives a member the roles of the tracked link they joined through. */
export async function grantLinkRoles(member: GuildMember, link: Pick<TrackedLinkRow, "roleIds">): Promise<string[]> {
  const wanted = parseRoleIds(link.roleIds).filter((id) => !member.roles.cache.has(id));
  const toAdd = autoGrantableRoleIds(member.guild, wanted);
  if (toAdd.length === 0) return [];
  const ok = await member.roles.add(toAdd, ROLE_REASON).then(
    () => true,
    (error: unknown) => {
      log.warn(`Could not add tracked-link roles in ${member.guild.id}: ${error instanceof Error ? error.message : error}`);
      return false;
    },
  );
  return ok ? toAdd : [];
}
