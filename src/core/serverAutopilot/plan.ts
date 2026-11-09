/**
 * Server Autopilot build plans: the exact operations a build will perform, computed
 * deterministically from (template, mode, keep lists, live guild snapshot). Pure, so the plan the
 * manager reviews and the work the build does always agree, and every rule is tested.
 */
import { PermissionFlagsBits } from "discord.js";
import { detectPurpose, detectRolePreset, normalizeName } from "./detect.js";
import { formatName } from "./naming.js";
import {
  clampOverwrites,
  isStaffPreset,
  isVoiceType,
  overwriteSignature,
  planCategoryOverwrites,
  planChannelOverwrites,
  rolePermissions,
  samePlannedOverwrites,
  type OverwriteTarget,
  type PlannedOverwrite,
} from "./permissions.js";
import { protectedChannelIds, roleEditable, type GuildSnapshot, type SnapChannel, type SnapKind } from "./snapshot.js";
import {
  SA_LIMITS,
  type SAChannel,
  type SAChannelType,
  type SAMessage,
  type SAMode,
  type SAOp,
  type SAPlan,
  type SAPluginSetup,
  type SATemplate,
} from "./types.js";

export type StoredOverwrite = { target: OverwriteTarget; allow: string; deny: string };

export type RoleAction = {
  key: string;
  action: "create" | "update" | "reuse";
  roleId: string | null;
  name: string;
  color: number | null;
  hoist: boolean;
  mentionable: boolean;
  /** Bitfield (string) to create with / set; for updates it already includes the role's own permissions. */
  permissions: string;
  changes: string[];
  editable: boolean;
};

export type ChannelAction = {
  key: string;
  isCategory: boolean;
  action: "create" | "update" | "reuse";
  channelId: string | null;
  name: string;
  type: SAChannelType | "category";
  parentKey: string | null;
  topic: string;
  nsfw: boolean;
  slowmode: number;
  userLimit: number;
  overwrites: StoredOverwrite[];
  /** Channel follows its category's permissions. */
  syncWithParent: boolean;
  changes: string[];
};

export type ResolvedPlan = {
  roles: RoleAction[];
  categories: ChannelAction[];
  channels: ChannelAction[];
  deleteChannels: Array<{ id: string; name: string; kind: SnapKind }>;
  deleteRoles: Array<{ id: string; name: string }>;
  /** Template role keys, highest first. */
  roleOrder: string[];
  categoryOrder: string[];
  /** Channel keys per category key ("" = uncategorized), in display order. */
  channelOrder: Record<string, string[]>;
  plugins: SAPluginSetup[];
  messages: SAMessage[];
};

export type IdMap = { roles: Record<string, string>; channels: Record<string, string> };

export type PlanInput = {
  template: SATemplate;
  mode: SAMode;
  keep: { channelIds: string[]; roleIds: string[] };
  snap: GuildSnapshot;
  /** Ids a previous (interrupted) run of the same template created, reused first. */
  idMap?: IdMap;
};

const TEXT_GROUP = new Set<SnapKind>(["text", "announcement"]);

function compatible(type: SAChannelType, kind: SnapKind): boolean {
  if (type === "text" || type === "announcement") return TEXT_GROUP.has(kind);
  if (type === "forum") return kind === "forum";
  if (type === "voice") return kind === "voice";
  return kind === "stage" || kind === "voice";
}

/** Assigns template items to existing ones by best score, highest first, each used once. */
function greedyMatch<T>(
  items: Array<{ key: string; index: number }>,
  candidates: T[],
  idOf: (c: T) => string,
  score: (itemKey: string, candidate: T) => number,
  preset: Map<string, string>,
): Map<string, string> {
  const matched = new Map<string, string>();
  const used = new Set<string>();
  for (const [key, id] of preset) {
    if (candidates.some((c) => idOf(c) === id) && !used.has(id)) {
      matched.set(key, id);
      used.add(id);
    }
  }
  const pairs: Array<{ key: string; index: number; id: string; score: number; order: number }> = [];
  candidates.forEach((candidate, order) => {
    for (const item of items) {
      if (matched.has(item.key)) continue;
      const s = score(item.key, candidate);
      if (s > 0) pairs.push({ key: item.key, index: item.index, id: idOf(candidate), score: s, order });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.index - b.index || a.order - b.order);
  for (const pair of pairs) {
    if (matched.has(pair.key) || used.has(pair.id)) continue;
    matched.set(pair.key, pair.id);
    used.add(pair.id);
  }
  return matched;
}

const toStored = (list: PlannedOverwrite[]): StoredOverwrite[] => list.map((o) => ({ target: o.target, allow: o.allow.toString(), deny: o.deny.toString() }));

export function computePlan(input: PlanInput): { plan: SAPlan; resolved: ResolvedPlan } {
  const { template, mode, snap } = input;
  const keepChannels = new Set(input.keep.channelIds);
  const keepRoles = new Set(input.keep.roleIds);
  const warnings: string[] = [];
  const blockers: string[] = [];
  const botPerms = BigInt(snap.bot.permissions);
  const botAdmin = snap.bot.administrator;
  const botHas = (flag: bigint) => botAdmin || (botPerms & flag) !== 0n;

  if (!botHas(PermissionFlagsBits.ManageChannels)) blockers.push("Dreamliner needs the Manage Channels permission to build channels.");
  if (!botHas(PermissionFlagsBits.ManageRoles)) blockers.push("Dreamliner needs the Manage Roles permission to create roles and set channel permissions.");

  // Community-only channel types.
  const typeOf = (ch: SAChannel): SAChannelType => {
    if (snap.community) return ch.type;
    if (ch.type === "announcement" || ch.type === "forum") return "text";
    if (ch.type === "stage") return "voice";
    return ch.type;
  };
  if (!snap.community) {
    const converted = [...template.uncategorized, ...template.categories.flatMap((c) => c.channels)].filter((c) => typeOf(c) !== c.type);
    if (converted.length) {
      warnings.push(
        `This server isn't a Community server, so ${converted.length} announcement, forum or stage channel${converted.length === 1 ? "" : "s"} will be made as regular text or voice channels.`,
      );
    }
  }

  // ── Roles ────────────────────────────────────────────────────────────────
  const roleCandidates = snap.roles.filter((r) => !r.isEveryone && !r.managed && !r.isBooster && r.id !== snap.bot.roleId);
  const roleById = new Map(snap.roles.map((r) => [r.id, r]));
  const roleMatch = greedyMatch(
    template.roles.map((r, index) => ({ key: r.key, index })),
    roleCandidates,
    (r) => r.id,
    (key, existing) => {
      const role = template.roles.find((r) => r.key === key)!;
      if (normalizeName(existing.name) && normalizeName(existing.name) === normalizeName(role.name)) return 100;
      const preset = detectRolePreset(existing.name);
      if (preset && preset === role.preset && !["cosmetic", "ping", "staff", "bot"].includes(preset)) return 80;
      return 0;
    },
    new Map(Object.entries(input.idMap?.roles ?? {})),
  );

  const roles: RoleAction[] = [];
  for (const role of template.roles) {
    const desired = rolePermissions(role, botPerms, botAdmin);
    if (desired.dropped.length) {
      warnings.push(`"${role.name}" won't get ${desired.dropped.slice(0, 4).join(", ")}${desired.dropped.length > 4 ? "…" : ""}: Dreamliner doesn't have ${desired.dropped.length === 1 ? "that permission" : "those permissions"} itself.`);
    }
    const existingId = roleMatch.get(role.key);
    const existing = existingId ? roleById.get(existingId) : undefined;
    if (!existing) {
      roles.push({
        key: role.key,
        action: "create",
        roleId: null,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: desired.permissions.toString(),
        changes: [],
        editable: true,
      });
      continue;
    }
    const editable = roleEditable(snap, existing) && !keepRoles.has(existing.id);
    const current = BigInt(existing.permissions);
    const merged = current | desired.permissions;
    const changes: string[] = [];
    if (existing.name !== role.name) changes.push("name");
    if (role.color !== null && existing.color !== role.color) changes.push("color");
    if (existing.hoist !== role.hoist) changes.push("hoist");
    if (existing.mentionable !== role.mentionable) changes.push("mentionable");
    if (merged !== current) changes.push("permissions");
    const canUpdate = mode !== "add" && editable;
    if (changes.length && !canUpdate && mode !== "add") {
      warnings.push(
        keepRoles.has(existing.id)
          ? `@${existing.name} is on your keep list, so it's used as it is.`
          : `@${existing.name} is above Dreamliner's highest role (or managed), so it's used as it is.`,
      );
    }
    roles.push({
      key: role.key,
      action: canUpdate && changes.length ? "update" : "reuse",
      roleId: existing.id,
      name: canUpdate ? role.name : existing.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: (canUpdate ? merged : current).toString(),
      changes: canUpdate ? changes : [],
      editable,
    });
  }
  const roleIdByKey = new Map(roles.filter((r) => r.roleId).map((r) => [r.key, r.roleId!]));

  // ── Channels ─────────────────────────────────────────────────────────────
  const hasLogsPlugin = template.plugins.some((p) => p.plugin === "logs");
  const protectedIds = protectedChannelIds(snap, { includeLogs: !hasLogsPlugin });
  const existingChannels = snap.channels.filter((c) => c.kind !== "category" && c.kind !== "other");
  const existingCategories = snap.channels.filter((c) => c.kind === "category");
  const channelById = new Map(snap.channels.map((c) => [c.id, c]));
  const flat = [
    ...template.uncategorized.map((channel) => ({ channel, parentKey: null as string | null })),
    ...template.categories.flatMap((cat) => cat.channels.map((channel) => ({ channel, parentKey: cat.key as string | null }))),
  ];
  const flatByKey = new Map(flat.map((f) => [f.channel.key, f]));

  const idMapChannels = new Map(Object.entries(input.idMap?.channels ?? {}));
  const channelMatch = greedyMatch(
    flat.map((f, index) => ({ key: f.channel.key, index })),
    existingChannels,
    (c) => c.id,
    (key, existing) => {
      const { channel } = flatByKey.get(key)!;
      const type = typeOf(channel);
      if (!compatible(type, existing.kind)) return 0;
      let score = 0;
      const purpose = detectPurpose(existing.name, existing.kind, existing.topic);
      if (channel.purpose !== "other" && purpose === channel.purpose) score = 100;
      else if (normalizeName(existing.name) && normalizeName(existing.name) === normalizeName(channel.base)) score = 90;
      else if (normalizeName(existing.name) && normalizeName(existing.name) === normalizeName(formatName(template.naming, type, channel.base, channel.emoji))) score = 90;
      if (!score) return 0;
      if (existing.id === snap.rulesChannelId && channel.purpose === "rules") score += 20;
      if (existing.id === snap.publicUpdatesChannelId && (channel.purpose === "updates" || channel.purpose === "announcements")) score += 10;
      return score;
    },
    idMapChannels,
  );

  const categoryMatch = greedyMatch(
    template.categories.map((c, index) => ({ key: c.key, index })),
    existingCategories,
    (c) => c.id,
    (key, existing) => {
      const cat = template.categories.find((c) => c.key === key)!;
      const norm = normalizeName(existing.name);
      if (norm && (norm === normalizeName(cat.base) || norm === normalizeName(formatName(template.naming, "category", cat.base, cat.emoji)))) return 90;
      const matchedHere = cat.channels.filter((ch) => {
        const id = channelMatch.get(ch.key);
        return id && channelById.get(id)?.parentId === existing.id;
      }).length;
      return matchedHere >= 2 && matchedHere * 2 >= cat.channels.length ? 50 + matchedHere : 0;
    },
    idMapChannels,
  );

  const overwriteCtxRoles = template.roles.map((r) => ({ key: r.key, preset: r.preset }));

  /** Resolved ids for a planned overwrite list, or null when a target role doesn't exist yet. */
  const resolveIds = (list: PlannedOverwrite[]): Array<{ id: string; allow: bigint; deny: bigint }> | null => {
    const out: Array<{ id: string; allow: bigint; deny: bigint }> = [];
    for (const o of list) {
      const id = o.target.kind === "everyone" ? snap.id : o.target.kind === "bot" ? snap.bot.userId : roleIdByKey.get(o.target.key);
      if (!id) return null;
      out.push({ id, allow: o.allow, deny: o.deny });
    }
    return out;
  };
  const managedTargetIds = new Set<string>([snap.id, snap.bot.userId, ...roleIdByKey.values()]);
  const permissionsDiffer = (existing: SnapChannel, desired: PlannedOverwrite[]): boolean => {
    const resolved = resolveIds(desired);
    if (!resolved) return true;
    const current = existing.overwrites
      .filter((o) => managedTargetIds.has(o.id))
      .map((o) => ({ id: o.id, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
    return overwriteSignature(current) !== overwriteSignature(resolved);
  };

  const categoryActions: ChannelAction[] = [];
  const categoryIdByKey = new Map<string, string>();
  const plannedByCategory = new Map<string, PlannedOverwrite[]>();
  for (const cat of template.categories) {
    const name = formatName(template.naming, "category", cat.base, cat.emoji);
    const planned = clampOverwrites(planCategoryOverwrites({ access: cat.access, roleKeys: cat.role_keys, rules: cat.rules ?? [] }, overwriteCtxRoles), botPerms, botAdmin);
    plannedByCategory.set(cat.key, planned);
    const existingId = categoryMatch.get(cat.key);
    const existing = existingId ? channelById.get(existingId) : undefined;
    const base = { key: cat.key, isCategory: true, name, type: "category" as const, parentKey: null, topic: "", nsfw: false, slowmode: 0, userLimit: 0, overwrites: toStored(planned), syncWithParent: false };
    if (!existing) {
      categoryActions.push({ ...base, action: "create", channelId: null, changes: [] });
      continue;
    }
    categoryIdByKey.set(cat.key, existing.id);
    const locked = mode === "add" || keepChannels.has(existing.id) || protectedIds.has(existing.id);
    const changes: string[] = [];
    if (existing.name !== name) changes.push("name");
    if (permissionsDiffer(existing, planned)) changes.push("permissions");
    categoryActions.push({ ...base, name: locked ? existing.name : name, action: !locked && changes.length ? "update" : "reuse", channelId: existing.id, changes: locked ? [] : changes });
  }

  const channelActions: ChannelAction[] = [];
  const lockedReasons: string[] = [];
  const categoryByKey = new Map(template.categories.map((c) => [c.key, c]));
  for (const { channel, parentKey } of flat) {
    const type = typeOf(channel);
    const name = formatName(template.naming, type, channel.base, channel.emoji);
    const voice = isVoiceType(type);
    const category = parentKey ? (categoryByKey.get(parentKey) ?? null) : null;
    const categoryPlanned = parentKey ? (plannedByCategory.get(parentKey) ?? []) : [];
    // A channel with its own access or rules still carries its category's (planChannelOverwrites),
    // and is synced whenever that works out to exactly the category's overwrites.
    const planned = clampOverwrites(
      planChannelOverwrites(
        { access: channel.access, roleKeys: channel.role_keys, rules: channel.rules ?? [] },
        category ? { access: category.access, roleKeys: category.role_keys, rules: category.rules ?? [], planned: categoryPlanned } : null,
        overwriteCtxRoles,
        voice,
      ),
      botPerms,
      botAdmin,
    );
    const syncWithParent = category !== null && samePlannedOverwrites(planned, categoryPlanned);
    const existingId = channelMatch.get(channel.key);
    const existing = existingId ? channelById.get(existingId) : undefined;
    const base = {
      key: channel.key,
      isCategory: false,
      name,
      type,
      parentKey,
      topic: channel.topic,
      nsfw: channel.nsfw,
      slowmode: channel.slowmode,
      userLimit: channel.user_limit,
      overwrites: toStored(planned),
      syncWithParent,
    };
    if (!existing) {
      channelActions.push({ ...base, action: "create", channelId: null, changes: [] });
      continue;
    }
    const isProtected = protectedIds.has(existing.id);
    const locked = mode === "add" || keepChannels.has(existing.id) || isProtected;
    const changes: string[] = [];
    if (existing.name !== name) changes.push("name");
    if (!voice && channel.topic && existing.topic !== channel.topic) changes.push("topic");
    if (existing.nsfw !== channel.nsfw) changes.push("nsfw");
    if ((type === "text" || type === "forum") && existing.slowmode !== channel.slowmode) changes.push("slowmode");
    if (type === "voice" && existing.userLimit !== channel.user_limit) changes.push("user limit");
    const wantedParent = parentKey ? (categoryIdByKey.get(parentKey) ?? `new:${parentKey}`) : null;
    if ((existing.parentId ?? null) !== wantedParent) changes.push("move");
    if (permissionsDiffer(existing, planned)) changes.push("permissions");
    if (locked && changes.length && mode !== "add") lockedReasons.push(`#${existing.name}`);
    channelActions.push({ ...base, name: locked ? existing.name : name, action: !locked && changes.length ? "update" : "reuse", channelId: existing.id, changes: locked ? [] : changes });
  }
  if (lockedReasons.length) {
    warnings.push(`Kept ${lockedReasons.slice(0, 5).join(", ")}${lockedReasons.length > 5 ? "…" : ""} exactly as ${lockedReasons.length === 1 ? "it is" : "they are"} (Community, system, log or keep-list channel${lockedReasons.length === 1 ? "" : "s"}).`);
  }

  // ── Deletes (fresh only) ─────────────────────────────────────────────────
  const deleteChannels: ResolvedPlan["deleteChannels"] = [];
  const deleteRoles: ResolvedPlan["deleteRoles"] = [];
  const usedChannelIds = new Set([...channelMatch.values(), ...categoryMatch.values()]);
  if (mode === "fresh") {
    const keptCategoryIds = new Set(existingCategories.filter((c) => keepChannels.has(c.id)).map((c) => c.id));
    let protectedKept = 0;
    for (const channel of existingChannels) {
      if (usedChannelIds.has(channel.id)) continue;
      if (protectedIds.has(channel.id)) {
        protectedKept += 1;
        continue;
      }
      if (keepChannels.has(channel.id) || (channel.parentId && keptCategoryIds.has(channel.parentId))) continue;
      deleteChannels.push({ id: channel.id, name: channel.name, kind: channel.kind });
    }
    for (const category of existingCategories) {
      if (usedChannelIds.has(category.id) || keepChannels.has(category.id) || protectedIds.has(category.id)) continue;
      deleteChannels.push({ id: category.id, name: category.name, kind: "category" });
    }
    if (protectedKept) warnings.push(`${protectedKept} Community, system or log channel${protectedKept === 1 ? " is" : "s are"} kept even in a fresh build.`);
    const usedRoleIds = new Set(roleMatch.values());
    for (const role of snap.roles) {
      if (usedRoleIds.has(role.id) || keepRoles.has(role.id) || !roleEditable(snap, role)) continue;
      deleteRoles.push({ id: role.id, name: role.name });
    }
    const skippedRoles = snap.roles.filter((r) => !r.isEveryone && !usedRoleIds.has(r.id) && !keepRoles.has(r.id) && !roleEditable(snap, r)).length;
    if (skippedRoles) warnings.push(`${skippedRoles} role${skippedRoles === 1 ? "" : "s"} can't be removed (managed by an integration, the booster role, or above Dreamliner) and will stay.`);
  }
  if (keepChannels.size || keepRoles.size) {
    const keptChannelCount = [...keepChannels].filter((id) => channelById.has(id)).length;
    const keptRoleCount = [...keepRoles].filter((id) => roleById.has(id)).length;
    if (keptChannelCount + keptRoleCount) warnings.push(`Keeping ${keptChannelCount} channel${keptChannelCount === 1 ? "" : "s"} and ${keptRoleCount} role${keptRoleCount === 1 ? "" : "s"} you chose to keep.`);
  }

  // ── Limits ───────────────────────────────────────────────────────────────
  const creates = categoryActions.filter((a) => a.action === "create").length + channelActions.filter((a) => a.action === "create").length;
  const totalChannels = snap.channels.length - deleteChannels.length + creates;
  if (totalChannels > SA_LIMITS.guildChannels) blockers.push(`This would leave ${totalChannels} channels; Discord allows at most ${SA_LIMITS.guildChannels}.`);
  const roleCreates = roles.filter((r) => r.action === "create").length;
  const totalRoles = snap.roles.length - deleteRoles.length + roleCreates;
  if (totalRoles > SA_LIMITS.guildRoles) blockers.push(`This would leave ${totalRoles} roles; Discord allows at most ${SA_LIMITS.guildRoles}.`);
  const deletedIds = new Set(deleteChannels.map((d) => d.id));
  const movedAway = new Set(channelActions.filter((a) => a.channelId).map((a) => a.channelId!));
  for (const cat of categoryActions) {
    if (!cat.channelId) continue;
    const staying = existingChannels.filter((c) => c.parentId === cat.channelId && !deletedIds.has(c.id) && !movedAway.has(c.id)).length;
    const count = staying + (template.categories.find((c) => c.key === cat.key)?.channels.length ?? 0);
    if (count > SA_LIMITS.channelsPerCategory) blockers.push(`"${cat.name}" would have ${count} channels; Discord allows at most ${SA_LIMITS.channelsPerCategory} per category.`);
  }

  // Hierarchy notes for staff roles that can't sit above other staff.
  const staffCreates = template.roles.filter((r) => isStaffPreset(r.preset) && roles.find((a) => a.key === r.key)?.action === "create");
  if (staffCreates.length && !botAdmin && snap.bot.highestPosition <= 1) {
    warnings.push("Dreamliner's role is at the bottom of the role list, so new roles can't be ordered above anyone. Move Dreamliner's role up for the best result.");
  }

  // ── Plugins and messages ─────────────────────────────────────────────────
  const nameByKey = new Map<string, string>([...categoryActions, ...channelActions].map((a) => [a.key, a.name]));
  const roleNameByKey = new Map(roles.map((r) => [r.key, r.name]));
  const pluginOps: SAOp[] = template.plugins.map((p) => ({ op: "configure_plugin", plugin: p.plugin, summary: pluginSummary(p, nameByKey, roleNameByKey) }));
  const messageOps: SAOp[] = template.messages.map((m) => ({ op: "post_message", key: m.key, channelKey: m.channel_key, title: m.title }));

  // ── Ops ──────────────────────────────────────────────────────────────────
  const ops: SAOp[] = [];
  for (const r of roles) {
    if (r.action === "create") ops.push({ op: "create_role", key: r.key, name: r.name, color: r.color });
    else if (r.action === "update") ops.push({ op: "update_role", roleId: r.roleId!, key: r.key, from: roleById.get(r.roleId!)!.name, to: r.name, changes: r.changes });
  }
  for (const c of [...categoryActions, ...channelActions]) {
    if (c.action === "create") ops.push({ op: c.isCategory ? "create_category" : "create_channel", key: c.key, name: c.name, type: c.type, parentKey: c.parentKey });
    else if (c.action === "update") ops.push({ op: "update_channel", channelId: c.channelId!, key: c.key, from: channelById.get(c.channelId!)!.name, to: c.name, changes: c.changes });
  }
  const reorderCount = template.categories.length + flat.length + roles.filter((r) => r.editable).length;
  if (reorderCount) ops.push({ op: "reorder", count: reorderCount });
  for (const d of deleteChannels.filter((d) => d.kind !== "category")) {
    ops.push({ op: "delete_channel", channelId: d.id, name: d.name, type: d.kind, messageWarning: Boolean(channelById.get(d.id)?.hasMessages) && (d.kind === "text" || d.kind === "announcement" || d.kind === "forum") });
  }
  for (const d of deleteChannels.filter((d) => d.kind === "category")) ops.push({ op: "delete_channel", channelId: d.id, name: d.name, type: d.kind, messageWarning: false });
  for (const d of deleteRoles) ops.push({ op: "delete_role", roleId: d.id, name: d.name });
  ops.push(...pluginOps, ...messageOps);

  const counts = {
    create: roleCreates + creates,
    update: roles.filter((r) => r.action === "update").length + categoryActions.filter((a) => a.action === "update").length + channelActions.filter((a) => a.action === "update").length,
    delete: deleteChannels.length + deleteRoles.length,
    plugins: pluginOps.length,
    messages: messageOps.length,
  };

  const channelOrder: Record<string, string[]> = { "": template.uncategorized.map((c) => c.key) };
  for (const cat of template.categories) channelOrder[cat.key] = cat.channels.map((c) => c.key);

  return {
    plan: {
      mode,
      ops,
      counts,
      warnings: [...new Set(warnings)],
      blockers,
      requiresConfirm: counts.delete > 0,
      estimatedSeconds: Math.round(5 + counts.create * 1.2 + counts.update * 1 + counts.delete * 0.8 + counts.plugins * 0.5 + counts.messages * 2),
    },
    resolved: {
      roles,
      categories: categoryActions,
      channels: channelActions,
      deleteChannels,
      deleteRoles,
      roleOrder: template.roles.map((r) => r.key),
      categoryOrder: template.categories.map((c) => c.key),
      channelOrder,
      plugins: template.plugins,
      messages: template.messages,
    },
  };
}

const PLUGIN_LABELS: Record<string, string> = {
  welcome_message: "Welcome messages",
  logs: "Server and moderation logs",
  tickets: "Tickets",
  role_panels: "Role picker",
  automod: "Automod",
  starboard: "Starboard",
  counting: "Counting",
  suggestions: "Suggestions",
  autorole: "Autorole",
  passport: "Passport verification",
  birthdays: "Birthdays",
  giveaways: "Giveaways",
  activity_rewards: "Activity Rewards",
  invite_tracker: "Invite Tracker",
};

export function pluginLabel(plugin: string): string {
  return PLUGIN_LABELS[plugin] ?? plugin;
}

function pluginSummary(p: SAPluginSetup, channelNames: Map<string, string>, roleNames: Map<string, string>): string {
  const label = pluginLabel(p.plugin);
  const channel = p.channel_key ? channelNames.get(p.channel_key) : undefined;
  const role = p.role_key ? roleNames.get(p.role_key) : undefined;
  const parts: string[] = [label];
  if (p.plugin === "automod") parts.push(`(${p.level} preset)`);
  if (channel) parts.push(`in #${channel}`);
  if (role) parts.push(p.plugin === "autorole" ? `giving @${role}` : p.plugin === "passport" ? `granting @${role}` : `for @${role}`);
  if (p.plugin === "role_panels") return "Role picker buttons, posted as a starter message";
  return parts.join(" ");
}

/** Permission names the bot is missing for everything a template's roles want (for the scan page). */
export function missingBotPermissions(template: SATemplate, snap: GuildSnapshot): string[] {
  const botPerms = BigInt(snap.bot.permissions);
  const missing = new Set<string>();
  for (const role of template.roles) for (const name of rolePermissions(role, botPerms, snap.bot.administrator).dropped) missing.add(name);
  return [...missing];
}
