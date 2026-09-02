import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildPermissionRoleGrants, guildPermissionRoleTargets, guildPermissionRoles } from "../db/schema.js";
import { BUILT_IN_ROLE_GRANTS, BUILT_IN_ROLE_NAMES, type BuiltInTier } from "./permissionRoleDefaults.js";

// Dreamliner Roles: CRUD for the new role-based permission system, backed by structured DB
// tables (guild_permission_roles/_targets/_grants) rather than the guild config's YAML blob —
// deliberately a separate manager from ConfigManager, since this is DB-row CRUD (create/rename/
// delete a role, replace its targets, toggle one grant) rather than load-YAML/mutate/re-save.

export type PermissionRoleTarget = { type: "role" | "user"; id: string };

export type PermissionRoleSummary = {
  id: number;
  guildId: string;
  name: string;
  color: number | null;
  builtIn: BuiltInTier | null;
  position: number;
  targetCount: number;
  grantCount: number;
};

export type PermissionRoleDetail = PermissionRoleSummary & {
  targets: PermissionRoleTarget[];
  grants: string[];
};

export type PermissionRoleMutationResult =
  | { success: true; data: PermissionRoleDetail }
  | { success: false; error: string };

function now() {
  return new Date();
}

type PermissionRoleChangeListener = (guildId: string) => void;

export class PermissionRoleManager {
  private changeListeners = new Set<PermissionRoleChangeListener>();

  /** Subscribe to any role/target/grant mutation for cache invalidation (see core/permissionRoles.ts). */
  onChange(listener: PermissionRoleChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(guildId: string) {
    for (const listener of this.changeListeners) listener(guildId);
  }

  private async loadDetail(roleId: number): Promise<PermissionRoleDetail | null> {
    const db = getDb();
    const role = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).get();
    if (!role) return null;
    const targets = db
      .select()
      .from(guildPermissionRoleTargets)
      .where(eq(guildPermissionRoleTargets.roleId, roleId))
      .all();
    const grants = db.select().from(guildPermissionRoleGrants).where(eq(guildPermissionRoleGrants.roleId, roleId)).all();
    return {
      id: role.id,
      guildId: role.guildId,
      name: role.name,
      color: role.color,
      builtIn: (role.builtIn as BuiltInTier | null) ?? null,
      position: role.position,
      targetCount: targets.length,
      grantCount: grants.length,
      targets: targets.map((t) => ({ type: t.targetType as "role" | "user", id: t.targetId })),
      grants: grants.map((g) => g.grantKey),
    };
  }

  async listRoles(guildId: string): Promise<PermissionRoleSummary[]> {
    await this.ensureDefaultRoles(guildId);
    const db = getDb();
    const roles = db
      .select()
      .from(guildPermissionRoles)
      .where(eq(guildPermissionRoles.guildId, guildId))
      .orderBy(guildPermissionRoles.position, guildPermissionRoles.id)
      .all();
    if (roles.length === 0) return [];
    const roleIds = roles.map((r) => r.id);
    const targets = db
      .select()
      .from(guildPermissionRoleTargets)
      .where(inArray(guildPermissionRoleTargets.roleId, roleIds))
      .all();
    const grants = db.select().from(guildPermissionRoleGrants).where(inArray(guildPermissionRoleGrants.roleId, roleIds)).all();
    const targetCounts = new Map<number, number>();
    for (const t of targets) targetCounts.set(t.roleId, (targetCounts.get(t.roleId) ?? 0) + 1);
    const grantCounts = new Map<number, number>();
    for (const g of grants) grantCounts.set(g.roleId, (grantCounts.get(g.roleId) ?? 0) + 1);
    return roles.map((role) => ({
      id: role.id,
      guildId: role.guildId,
      name: role.name,
      color: role.color,
      builtIn: (role.builtIn as BuiltInTier | null) ?? null,
      position: role.position,
      targetCount: targetCounts.get(role.id) ?? 0,
      grantCount: grantCounts.get(role.id) ?? 0,
    }));
  }

  async getRole(guildId: string, roleId: number): Promise<PermissionRoleDetail | null> {
    await this.ensureDefaultRoles(guildId);
    const detail = await this.loadDetail(roleId);
    if (!detail || detail.guildId !== guildId) return null;
    return detail;
  }

  async createRole(guildId: string, name: string, _updatedBy: string): Promise<PermissionRoleDetail> {
    const db = getDb();
    const timestamp = now();
    const existing = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId)).all();
    const position = existing.length > 0 ? Math.max(...existing.map((r) => r.position)) + 1 : 0;
    const inserted = db
      .insert(guildPermissionRoles)
      .values({ guildId, name: name.trim().slice(0, 100), builtIn: null, position, createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get();
    this.notifyChange(guildId);
    return (await this.loadDetail(inserted.id))!;
  }

  async renameRole(guildId: string, roleId: number, name: string, _updatedBy: string): Promise<PermissionRoleMutationResult> {
    const db = getDb();
    const role = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).get();
    if (!role || role.guildId !== guildId) return { success: false, error: "Role not found." };
    db.update(guildPermissionRoles)
      .set({ name: name.trim().slice(0, 100), updatedAt: now() })
      .where(eq(guildPermissionRoles.id, roleId))
      .run();
    this.notifyChange(guildId);
    return { success: true, data: (await this.loadDetail(roleId))! };
  }

  async deleteRole(guildId: string, roleId: number, _updatedBy: string): Promise<{ success: true } | { success: false; error: string }> {
    const db = getDb();
    const role = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).get();
    if (!role || role.guildId !== guildId) return { success: false, error: "Role not found." };
    if (role.builtIn) return { success: false, error: "Built-in roles can't be deleted." };
    db.delete(guildPermissionRoleTargets).where(eq(guildPermissionRoleTargets.roleId, roleId)).run();
    db.delete(guildPermissionRoleGrants).where(eq(guildPermissionRoleGrants.roleId, roleId)).run();
    db.delete(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).run();
    this.notifyChange(guildId);
    return { success: true };
  }

  async setTargets(
    guildId: string,
    roleId: number,
    targets: PermissionRoleTarget[],
    _updatedBy: string,
  ): Promise<PermissionRoleMutationResult> {
    const db = getDb();
    const role = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).get();
    if (!role || role.guildId !== guildId) return { success: false, error: "Role not found." };
    if (role.builtIn === "member") return { success: false, error: "The Member role applies to everyone and can't have targets." };

    db.transaction((tx) => {
      tx.delete(guildPermissionRoleTargets).where(eq(guildPermissionRoleTargets.roleId, roleId)).run();
      const deduped = new Map(targets.map((t) => [`${t.type}:${t.id}`, t]));
      for (const target of deduped.values()) {
        tx.insert(guildPermissionRoleTargets).values({ roleId, targetType: target.type, targetId: target.id }).run();
      }
      tx.update(guildPermissionRoles).set({ updatedAt: now() }).where(eq(guildPermissionRoles.id, roleId)).run();
    });
    this.notifyChange(guildId);
    return { success: true, data: (await this.loadDetail(roleId))! };
  }

  async setGrant(guildId: string, roleId: number, grantKey: string, granted: boolean, _updatedBy: string): Promise<PermissionRoleMutationResult> {
    const db = getDb();
    const role = db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.id, roleId)).get();
    if (!role || role.guildId !== guildId) return { success: false, error: "Role not found." };

    if (granted) {
      db.insert(guildPermissionRoleGrants).values({ roleId, grantKey }).onConflictDoNothing().run();
    } else {
      db.delete(guildPermissionRoleGrants)
        .where(and(eq(guildPermissionRoleGrants.roleId, roleId), eq(guildPermissionRoleGrants.grantKey, grantKey)))
        .run();
    }
    db.update(guildPermissionRoles).set({ updatedAt: now() }).where(eq(guildPermissionRoles.id, roleId)).run();
    this.notifyChange(guildId);
    return { success: true, data: (await this.loadDetail(roleId))! };
  }

  /** Idempotent — seeds the 3 built-in roles (Member/Moderator/Admin) with their default grants if this guild has no permission roles yet at all. Safe to call on every read. */
  async ensureDefaultRoles(guildId: string): Promise<void> {
    const db = getDb();
    const existing = db.select({ id: guildPermissionRoles.id }).from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId)).all();
    if (existing.length > 0) return;

    const timestamp = now();
    db.transaction((tx) => {
      let position = 0;
      for (const tier of ["member", "moderator", "admin"] as const) {
        const role = tx
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
        for (const grantKey of BUILT_IN_ROLE_GRANTS[tier]) {
          tx.insert(guildPermissionRoleGrants).values({ roleId: role.id, grantKey }).onConflictDoNothing().run();
        }
      }
    });
  }
}

export const permissionRoleManager = new PermissionRoleManager();
