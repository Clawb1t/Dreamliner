import {
  permissionRoleManager,
  type PermissionRoleDetail,
  type PermissionRoleSummary,
  type PermissionRoleTarget,
} from "../config/permissionRoleManager.js";
import { getPermissionCatalog, type PermissionCatalogGroup } from "../core/permissionCatalog.js";

// Dreamliner Roles bridge — new, separate plumbing from the rest of dashboardBridge.ts's guild
// config routes: this is DB-row CRUD backed directly by PermissionRoleManager, not the YAML
// full-replace GET/PUT /bridge/guilds/:id/config path everything else uses.

export type BridgeResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export async function listPermissionRoles(guildId: string): Promise<BridgeResult<{ roles: PermissionRoleSummary[] }>> {
  const roles = await permissionRoleManager.listRoles(guildId);
  return { ok: true, roles };
}

export async function getPermissionRole(guildId: string, roleId: number): Promise<BridgeResult<{ role: PermissionRoleDetail }>> {
  const role = await permissionRoleManager.getRole(guildId, roleId);
  if (!role) return { ok: false, status: 404, error: "Role not found." };
  return { ok: true, role };
}

export async function createPermissionRole(guildId: string, actorId: string, name: string): Promise<BridgeResult<{ role: PermissionRoleDetail }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, status: 400, error: "name is required." };
  const role = await permissionRoleManager.createRole(guildId, trimmed, actorId);
  return { ok: true, role };
}

export async function renamePermissionRole(
  guildId: string,
  roleId: number,
  actorId: string,
  name: string,
): Promise<BridgeResult<{ role: PermissionRoleDetail }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, status: 400, error: "name is required." };
  const result = await permissionRoleManager.renameRole(guildId, roleId, trimmed, actorId);
  if (!result.success) return { ok: false, status: 400, error: result.error };
  return { ok: true, role: result.data };
}

export async function deletePermissionRole(guildId: string, roleId: number, actorId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const result = await permissionRoleManager.deleteRole(guildId, roleId, actorId);
  if (!result.success) return { ok: false, status: 400, error: result.error };
  return { ok: true };
}

function parseTargets(raw: unknown): PermissionRoleTarget[] | null {
  if (!Array.isArray(raw)) return null;
  const targets: PermissionRoleTarget[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { type, id } = entry as { type?: unknown; id?: unknown };
    if ((type !== "role" && type !== "user") || typeof id !== "string" || !id) return null;
    targets.push({ type, id });
  }
  return targets;
}

export async function setPermissionRoleTargets(
  guildId: string,
  roleId: number,
  actorId: string,
  rawTargets: unknown,
): Promise<BridgeResult<{ role: PermissionRoleDetail }>> {
  const targets = parseTargets(rawTargets);
  if (!targets) return { ok: false, status: 400, error: "targets must be an array of {type: 'role'|'user', id}." };
  const result = await permissionRoleManager.setTargets(guildId, roleId, targets, actorId);
  if (!result.success) return { ok: false, status: 400, error: result.error };
  return { ok: true, role: result.data };
}

export async function setPermissionRoleGrant(
  guildId: string,
  roleId: number,
  actorId: string,
  grantKey: unknown,
  granted: unknown,
): Promise<BridgeResult<{ role: PermissionRoleDetail }>> {
  if (typeof grantKey !== "string" || !grantKey) return { ok: false, status: 400, error: "grantKey is required." };
  if (typeof granted !== "boolean") return { ok: false, status: 400, error: "granted must be a boolean." };
  const result = await permissionRoleManager.setGrant(guildId, roleId, grantKey, granted, actorId);
  if (!result.success) return { ok: false, status: 400, error: result.error };
  return { ok: true, role: result.data };
}

export async function getPermissionCatalogForWeb(): Promise<{ ok: true; catalog: PermissionCatalogGroup[] }> {
  return { ok: true, catalog: getPermissionCatalog() };
}
