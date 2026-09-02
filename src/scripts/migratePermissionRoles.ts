import YAML from "yaml";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildConfigs, guildPermissionRoleGrants, guildPermissionRoleTargets, guildPermissionRoles } from "../db/schema.js";
import { BUILT_IN_ROLE_GRANTS, BUILT_IN_ROLE_NAMES, type BuiltInTier } from "../config/permissionRoleDefaults.js";

// One-time, idempotent migration from the old level+override permission model to Dreamliner
// Roles. Runs at boot, right after runMigrations() and before the Discord client logs in or
// any guild config is loaded through ConfigManager — load-bearing ordering: once a guild's
// config passes through ConfigManager.getGuildConfig, its repair-on-load logic strips the now-
// unknown `levels`/`overrides`/`replaceDefaultOverrides` keys and RE-SAVES the config, destroying
// the very data this migration reads. So this reads guild_configs.configYaml directly via
// YAML.parse, bypassing zod validation entirely, rather than going through ConfigManager.
//
// Per guild: skip if it already has any permission-role rows (idempotent — safe to call every
// boot). Otherwise seed the 3 built-in roles (Member/Moderator/Admin) from BUILT_IN_ROLE_GRANTS,
// then walk the guild's old `levels` map and assign each entry into the closest-matching tier by
// threshold (>=75 -> Admin, >=25 -> Moderator, else skipped since Member is implicit-everyone).
// A `levels` snowflake could be either a Discord role or a user id and there's no live guild
// cache available yet to tell them apart at this point in boot — so each one is inserted as BOTH
// a role-type and a user-type target (harmless: onConflictDoNothing keeps it cheap, and whichever
// type doesn't match anything real is simply never live at read time).
//
// Any custom per-plugin `overrides` (channel/category/user/role-scoped extra grants) are NOT
// migrated — there's no structural equivalent in the new model — just logged so operators have a
// paper trail of what was dropped.

function now() {
  return new Date();
}

function seedBuiltInRoles(guildId: string): Record<BuiltInTier, number> {
  const db = getDb();
  const timestamp = now();
  const ids = {} as Record<BuiltInTier, number>;
  let position = 0;
  for (const tier of ["member", "moderator", "admin"] as const) {
    const role = db
      .insert(guildPermissionRoles)
      .values({
        guildId,
        name: BUILT_IN_ROLE_NAMES[tier],
        builtIn: tier,
        position: position++,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    ids[tier] = role.id;
    for (const grantKey of BUILT_IN_ROLE_GRANTS[tier]) {
      db.insert(guildPermissionRoleGrants).values({ roleId: role.id, grantKey }).onConflictDoNothing().run();
    }
  }
  return ids;
}

function tierForLevel(level: number): BuiltInTier | null {
  if (level >= 75) return "admin";
  if (level >= 25) return "moderator";
  return null;
}

export function runPermissionRoleMigration(): void {
  const db = getDb();
  const rows = db.select().from(guildConfigs).all();

  for (const row of rows) {
    try {
      const alreadyMigrated = db
        .select({ id: guildPermissionRoles.id })
        .from(guildPermissionRoles)
        .where(eq(guildPermissionRoles.guildId, row.guildId))
        .get();
      if (alreadyMigrated) continue;

      let parsed: Record<string, unknown> = {};
      try {
        parsed = (YAML.parse(row.configYaml) ?? {}) as Record<string, unknown>;
      } catch {
        // Unparseable stored config — nothing to migrate from, still seed defaults below.
      }

      const roleIds = seedBuiltInRoles(row.guildId);

      const legacyLevels = (parsed.levels ?? {}) as Record<string, unknown>;
      for (const [snowflakeId, rawLevel] of Object.entries(legacyLevels)) {
        const level = Number(rawLevel);
        if (!Number.isFinite(level)) continue;
        const tier = tierForLevel(level);
        if (!tier) continue;
        const roleId = roleIds[tier];
        db.insert(guildPermissionRoleTargets).values({ roleId, targetType: "role", targetId: snowflakeId }).onConflictDoNothing().run();
        db.insert(guildPermissionRoleTargets).values({ roleId, targetType: "user", targetId: snowflakeId }).onConflictDoNothing().run();
      }

      const plugins = (parsed.plugins ?? {}) as Record<string, unknown>;
      const droppedOverridePlugins = Object.entries(plugins)
        .filter(([, section]) => {
          const overrides = (section as { overrides?: unknown } | null)?.overrides;
          return Array.isArray(overrides) && overrides.length > 0;
        })
        .map(([name]) => name);
      if (droppedOverridePlugins.length > 0) {
        console.warn(
          `[dreamliner] Guild ${row.guildId}: dropped custom permission overrides during the Dreamliner Roles migration (no structural equivalent in the new model): ${droppedOverridePlugins.join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`[dreamliner] Permission role migration failed for guild ${row.guildId}:`, err);
    }
  }
}
