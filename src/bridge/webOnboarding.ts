/**
 * First-run dashboard setup ("onboarding"): the guided flow the website shows the first time a
 * manager opens a server's dashboard, and again whenever they pick "Run setup again".
 *
 *   GET  /bridge/guilds/:id/onboarding?userId=        -> { state, actor }
 *   PUT  /bridge/guilds/:id/onboarding                { userId, action, step?, answers? } -> { state }
 *   POST /bridge/guilds/:id/onboarding/create         { userId, kind, name, private? } -> { created }
 *
 * The flow itself (questions, plugin picks) lives on the website; the plugins it turns on are
 * saved through the normal config save. This file only remembers where the flow got to, the
 * answers, and who did it, so it can resume, and it creates the odd channel or role the flow
 * offers to make ("Create one for me"), within the member's own Discord permissions.
 *
 * A server with no row is new (status "pending", shown on open) unless its stored config is
 * already customised, in which case it counts as completed: servers set up before onboarding
 * existed never get the flow pushed on them.
 */
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildConfigs, guildOnboarding } from "../db/schema.js";
import { actorHas, requireActorPermissions, resolveActor } from "../core/actorPermissions.js";

export const ONBOARDING_STEPS = ["welcome", "purpose", "goals", "plugins", "essentials", "review", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_STATUSES = ["pending", "in_progress", "skipped", "completed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export const ONBOARDING_SIZES = ["small", "medium", "large"] as const;

export type OnboardingAnswers = {
  purposes: string[];
  size: (typeof ONBOARDING_SIZES)[number] | null;
  goals: string[];
  /** Plugins the member switched on in the flow. */
  plugins: string[];
  /** Plugins the member switched off in the flow (so a recommendation stays off on resume). */
  off: string[];
};

export type OnboardingState = {
  status: OnboardingStatus;
  step: OnboardingStep | null;
  answers: OnboardingAnswers;
  startedBy: string | null;
  updatedBy: string | null;
  completedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  /** True when there's no stored row and the status was worked out from the server's config. */
  implicit: boolean;
  /** Whether the dashboard should open the flow on its own (new, or left half way). */
  showOnOpen: boolean;
};

const ID = /^[a-z0-9_]{1,40}$/;
const MAX_LIST = 24;
const MAX_PLUGINS = 80;

function idList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !ID.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function emptyAnswers(): OnboardingAnswers {
  return { purposes: [], size: null, goals: [], plugins: [], off: [] };
}

/** Cleans answers from the website: known-looking ids only, no repeats, capped. */
export function normalizeAnswers(raw: unknown): OnboardingAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyAnswers();
  const value = raw as Record<string, unknown>;
  const size = typeof value.size === "string" && (ONBOARDING_SIZES as readonly string[]).includes(value.size)
    ? (value.size as OnboardingAnswers["size"])
    : null;
  return {
    purposes: idList(value.purposes, MAX_LIST),
    size,
    goals: idList(value.goals, MAX_LIST),
    plugins: idList(value.plugins, MAX_PLUGINS),
    off: idList(value.off, MAX_PLUGINS),
  };
}

function normalizeStep(raw: unknown): OnboardingStep | null {
  return typeof raw === "string" && (ONBOARDING_STEPS as readonly string[]).includes(raw) ? (raw as OnboardingStep) : null;
}

/** Plugins that ship switched on, so their bare `enabled: true` isn't a sign anyone set things up. */
const ON_BY_DEFAULT = new Set(["utility", "stats"]);
/** Top-level keys the bot itself writes (emoji migrations), never a sign of customisation. */
const SYSTEM_KEYS = new Set(["emojis"]);

/**
 * Whether a server's stored overrides (`user_config_json`) show someone already set it up: any
 * plugin switched on (beyond the on-by-default ones), any plugin settings, or any server-wide
 * setting. A config auto-provisioned on join is `{}` and counts as untouched.
 */
export function isConfigCustomised(userConfigJson: string | null | undefined): boolean {
  if (!userConfigJson?.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(userConfigJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (SYSTEM_KEYS.has(key) || value == null) continue;
    if (key !== "plugins") return true;
    if (typeof value !== "object") continue;
    for (const [plugin, section] of Object.entries(value as Record<string, unknown>)) {
      if (!section || typeof section !== "object") continue;
      const s = section as Record<string, unknown>;
      if (s.enabled === true && !ON_BY_DEFAULT.has(plugin)) return true;
      const config = s.config;
      if (config && typeof config === "object" && Object.keys(config).length > 0) return true;
    }
  }
  return false;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function parseAnswers(json: string | null): OnboardingAnswers {
  if (!json) return emptyAnswers();
  try {
    return normalizeAnswers(JSON.parse(json));
  } catch {
    return emptyAnswers();
  }
}

type Row = typeof guildOnboarding.$inferSelect;

function rowToState(row: Row): OnboardingState {
  const status = (ONBOARDING_STATUSES as readonly string[]).includes(row.status) ? (row.status as OnboardingStatus) : "pending";
  return {
    status,
    step: normalizeStep(row.step),
    answers: parseAnswers(row.answersJson),
    startedBy: row.startedBy,
    updatedBy: row.updatedBy,
    completedBy: row.completedBy,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    updatedAt: iso(row.updatedAt),
    implicit: false,
    showOnOpen: status === "pending" || status === "in_progress",
  };
}

function readRow(guildId: string): Row | undefined {
  return getDb().select().from(guildOnboarding).where(eq(guildOnboarding.guildId, guildId)).get();
}

export function getOnboardingState(guildId: string): OnboardingState {
  const row = readRow(guildId);
  if (row) return rowToState(row);
  const config = getDb()
    .select({ user: guildConfigs.userConfigJson })
    .from(guildConfigs)
    .where(eq(guildConfigs.guildId, guildId))
    .get();
  const customised = isConfigCustomised(config?.user);
  return {
    status: customised ? "completed" : "pending",
    step: null,
    answers: emptyAnswers(),
    startedBy: null,
    updatedBy: null,
    completedBy: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    implicit: true,
    showOnOpen: !customised,
  };
}

export const ONBOARDING_ACTIONS = ["start", "progress", "skip", "complete", "reset"] as const;
export type OnboardingAction = (typeof ONBOARDING_ACTIONS)[number];

type UpdateResult = { ok: true; state: OnboardingState } | { ok: false; status: number; error: string };

/**
 * Moves the flow along. `start` (re)opens it at `step` (default welcome), `progress` saves the
 * step and answers, `skip` closes it for now (a re-run of a finished setup stays completed),
 * `complete` marks it done, `reset` forgets it (it shows again on the next open, even on a
 * customised server).
 */
export function updateOnboardingState(guildId: string, userId: string, body: Record<string, unknown>): UpdateResult {
  const action = body.action;
  if (typeof action !== "string" || !(ONBOARDING_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, status: 400, error: `action must be one of ${ONBOARDING_ACTIONS.join(", ")}.` };
  }
  const current = getOnboardingState(guildId);
  const row = readRow(guildId);
  const now = new Date();
  const answers = body.answers !== undefined ? normalizeAnswers(body.answers) : current.answers;
  const step = normalizeStep(body.step);

  let next: Omit<Row, "guildId" | "welcomeSentAt">;
  const base = {
    startedBy: row?.startedBy ?? null,
    completedBy: row?.completedBy ?? null,
    startedAt: row?.startedAt ?? null,
    completedAt: row?.completedAt ?? null,
  };
  switch (action as OnboardingAction) {
    case "start":
      next = {
        ...base,
        status: "in_progress",
        step: step ?? "welcome",
        answersJson: JSON.stringify(answers),
        startedBy: userId,
        startedAt: now,
        updatedBy: userId,
        updatedAt: now,
      };
      break;
    case "progress":
      next = {
        ...base,
        status: "in_progress",
        step: step ?? current.step ?? "welcome",
        answersJson: JSON.stringify(answers),
        startedBy: base.startedBy ?? userId,
        startedAt: base.startedAt ?? now,
        updatedBy: userId,
        updatedAt: now,
      };
      break;
    case "skip":
      next = {
        ...base,
        // Skipping a re-run keeps a server that finished setup before as completed.
        status: base.completedAt ? "completed" : "skipped",
        step: step ?? current.step,
        answersJson: JSON.stringify(answers),
        updatedBy: userId,
        updatedAt: now,
      };
      break;
    case "complete":
      next = {
        ...base,
        status: "completed",
        step: "done",
        answersJson: JSON.stringify(answers),
        startedBy: base.startedBy ?? userId,
        startedAt: base.startedAt ?? now,
        completedBy: userId,
        completedAt: now,
        updatedBy: userId,
        updatedAt: now,
      };
      break;
    case "reset":
      next = {
        status: "pending",
        step: null,
        answersJson: null,
        startedBy: null,
        completedBy: null,
        startedAt: null,
        completedAt: null,
        updatedBy: userId,
        updatedAt: now,
      };
      break;
  }

  getDb()
    .insert(guildOnboarding)
    .values({ guildId, ...next })
    .onConflictDoUpdate({ target: guildOnboarding.guildId, set: next })
    .run();
  return { ok: true, state: getOnboardingState(guildId) };
}

/**
 * Claims the one welcome message for a server. True only for the first caller ever, so a rejoin,
 * a retry or two shards racing never post it twice.
 */
export function claimWelcomeMessage(guildId: string, now = new Date()): boolean {
  const result = getDb()
    .insert(guildOnboarding)
    .values({ guildId, status: "pending", welcomeSentAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: guildOnboarding.guildId,
      set: { welcomeSentAt: now },
      where: isNull(guildOnboarding.welcomeSentAt),
    })
    .run() as unknown as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** What the signed-in member (and the bot) may create, so the flow only offers what will work. */
export async function onboardingActor(guild: Guild, userId: string): Promise<{
  manageChannels: boolean;
  manageRoles: boolean;
  botManageChannels: boolean;
  botManageRoles: boolean;
}> {
  const actor = await resolveActor(guild, userId);
  const me = guild.members.me;
  return {
    manageChannels: actor ? actorHas(actor, PermissionFlagsBits.ManageChannels) : false,
    manageRoles: actor ? actorHas(actor, PermissionFlagsBits.ManageRoles) : false,
    botManageChannels: me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false,
    botManageRoles: me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
  };
}

export const ONBOARDING_CREATE_KINDS = ["text", "category", "role"] as const;
export type OnboardingCreateKind = (typeof ONBOARDING_CREATE_KINDS)[number];

/** A Discord-safe name: text channels lower-case with dashes, others just trimmed. */
export function cleanEntityName(kind: OnboardingCreateKind, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let name = raw.trim().replace(/\s+/g, " ");
  if (kind === "text") {
    name = name.toLowerCase().replace(/[^a-z0-9_\- ]/g, "").replace(/ /g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  } else {
    name = name.replace(/[\u0000-\u001f]/g, "");
  }
  name = name.slice(0, kind === "role" ? 100 : 90);
  return name.length >= 1 ? name : null;
}

type CreateResult =
  | { ok: true; created: { id: string; name: string; kind: OnboardingCreateKind } }
  | { ok: false; status: number; error: string; code?: string };

/**
 * "Create one for me": one text channel, category or role, for the setup flow's essentials. Needs
 * the member's own Manage Channels / Manage Roles (actorPermissions.ts) and the bot's. A private
 * text channel (logs) is hidden from everyone and readable by the bot.
 */
export async function createOnboardingEntity(guild: Guild, userId: string, body: Record<string, unknown>): Promise<CreateResult> {
  const kind = body.kind;
  if (typeof kind !== "string" || !(ONBOARDING_CREATE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, status: 400, error: "kind must be text, category or role." };
  }
  const k = kind as OnboardingCreateKind;
  const name = cleanEntityName(k, body.name);
  if (!name) return { ok: false, status: 400, error: "Give it a name." };
  const reason = `Dreamliner setup, requested by ${userId}`;
  const me = guild.members.me;

  if (k === "role") {
    await requireActorPermissions(guild, userId, ["ManageRoles"], "create roles");
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { ok: false, status: 403, error: "Dreamliner needs Manage Roles to create a role.", code: "bot_missing" };
    }
    const role = await guild.roles.create({ name, permissions: [], mentionable: false, reason });
    return { ok: true, created: { id: role.id, name: role.name, kind: k } };
  }

  await requireActorPermissions(guild, userId, ["ManageChannels"], "create channels");
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, status: 403, error: "Dreamliner needs Manage Channels to create a channel.", code: "bot_missing" };
  }
  if (k === "category") {
    const channel = await guild.channels.create({ name, type: ChannelType.GuildCategory, reason });
    return { ok: true, created: { id: channel.id, name: channel.name, kind: k } };
  }
  const isPrivate = body.private === true;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    reason,
    ...(isPrivate
      ? {
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            // The member who asked for it can always read it, even without Administrator.
            ...(guild.members.cache.has(userId) ? [{ id: userId, allow: [PermissionFlagsBits.ViewChannel] }] : []),
            {
              id: me.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
              ],
            },
          ],
        }
      : {}),
  });
  return { ok: true, created: { id: channel.id, name: channel.name, kind: k } };
}
