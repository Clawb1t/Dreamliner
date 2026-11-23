import type http from "node:http";
import { ChangelogError } from "../core/changelog/rules.js";
import type { ChangelogService } from "../core/changelog/service.js";
import { SlidingWindowLimiter } from "./rateLimit.js";

/**
 * Bridge routes for the public changelog.
 *
 *   GET  /bridge/public/changelog?page=&limit=      published updates, newest first (cached)
 *   GET  /bridge/public/changelog/:slug             one published update (cached)
 *   GET  /bridge/platform/changelog?userId=         operators: every update with its commits
 *   POST /bridge/platform/changelog/check           operators: look for new commits now
 *   POST /bridge/platform/changelog/generate-older  operators: write the next older drafts
 *   POST /bridge/platform/changelog/merge           operators: merge neighbouring updates
 *   PUT  /bridge/platform/changelog/:id             operators: edit text and/or status
 *   POST /bridge/platform/changelog/:id/regenerate  operators: rewrite with Autopilot
 *   POST /bridge/platform/changelog/:id/split       operators: split before a commit
 *
 * Like every /bridge/public/* route these still need the bridge secret (only the website calls
 * them); the website limits visitors per IP. Operator routes check the superuser list.
 */

export type ChangelogRouteDeps = {
  getService(): Promise<Pick<ChangelogService, "listPublic" | "getPublic" | "listAdmin" | "sync" | "generateOlder" | "merge" | "edit" | "generate" | "split" | "toAdmin">>;
  readBody(req: http.IncomingMessage): Promise<string>;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
  isSuperuser(userId: string | null | undefined): boolean;
  cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;
  invalidate(prefix: string): void;
};

/** Autopilot calls an operator can start: each regenerate or check can write up to a few updates. */
const operatorAiLimiter = new SlidingWindowLimiter(15, 10 * 60_000);

const CACHE_PREFIX = "changelog:";

async function readJson(req: http.IncomingMessage, deps: ChangelogRouteDeps): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await deps.readBody(req)) || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Handles the request if it's a changelog route. Returns false for anything else. */
export async function handleChangelogRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: ChangelogRouteDeps,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";

  // --- Public -------------------------------------------------------------------------------
  if (path === "/bridge/public/changelog" || path.startsWith("/bridge/public/changelog/")) {
    if (method !== "GET") {
      deps.sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const service = await deps.getService();
    if (path === "/bridge/public/changelog") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const key = `${CACHE_PREFIX}list:${Math.trunc(page) || 1}:${Math.trunc(limit) || 10}`;
      deps.sendJson(res, 200, { ok: true, ...(await deps.cached(key, 60_000, () => service.listPublic(page, limit))) });
      return true;
    }
    const slug = decodeURIComponent(path.slice("/bridge/public/changelog/".length));
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) {
      deps.sendJson(res, 404, { error: "Update not found." });
      return true;
    }
    const update = await deps.cached(`${CACHE_PREFIX}slug:${slug}`, 60_000, () => service.getPublic(slug));
    if (!update) {
      deps.sendJson(res, 404, { error: "Update not found." });
      return true;
    }
    deps.sendJson(res, 200, { ok: true, update });
    return true;
  }

  // --- Operators ------------------------------------------------------------------------------
  if (path !== "/bridge/platform/changelog" && !path.startsWith("/bridge/platform/changelog/")) return false;

  if (method === "GET" && path === "/bridge/platform/changelog") {
    if (!deps.isSuperuser(url.searchParams.get("userId")?.trim())) {
      deps.sendJson(res, 403, { error: "Platform access required." });
      return true;
    }
    deps.sendJson(res, 200, { ok: true, ...(await (await deps.getService()).listAdmin()) });
    return true;
  }

  if (method !== "POST" && method !== "PUT") {
    deps.sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  const body = await readJson(req, deps);
  if (!body) {
    deps.sendJson(res, 400, { error: "Invalid JSON body" });
    return true;
  }
  const actorId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!actorId || !deps.isSuperuser(actorId)) {
    deps.sendJson(res, 403, { error: "Platform access required." });
    return true;
  }

  const takeAi = (): boolean => {
    const result = operatorAiLimiter.take(actorId);
    if (result.ok) return true;
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    deps.sendJson(res, 429, { error: `Too many Autopilot runs. Try again in ${retryAfter}s.`, retryAfter });
    return false;
  };

  const service = await deps.getService();
  const idMatch = /^\/bridge\/platform\/changelog\/(\d{1,9})(?:\/(regenerate|split))?$/.exec(path);
  try {
    if (method === "POST" && path === "/bridge/platform/changelog/check") {
      if (!takeAi()) return true;
      const result = await service.sync();
      deps.invalidate(CACHE_PREFIX);
      deps.sendJson(res, 200, { ok: true, result });
      return true;
    }
    if (method === "POST" && path === "/bridge/platform/changelog/generate-older") {
      if (!takeAi()) return true;
      const result = await service.generateOlder(Number(body.count ?? 3));
      deps.invalidate(CACHE_PREFIX);
      deps.sendJson(res, 200, { ok: true, result });
      return true;
    }
    if (method === "POST" && path === "/bridge/platform/changelog/merge") {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      const row = await service.merge(ids, actorId);
      deps.invalidate(CACHE_PREFIX);
      deps.sendJson(res, 200, { ok: true, update: service.toAdmin(row) });
      return true;
    }
    if (idMatch) {
      const id = Number(idMatch[1]);
      const action = idMatch[2];
      if (method === "PUT" && !action) {
        const row = await service.edit(id, { content: body.content, status: body.status }, actorId);
        deps.invalidate(CACHE_PREFIX);
        deps.sendJson(res, 200, { ok: true, update: service.toAdmin(row) });
        return true;
      }
      if (method === "POST" && action === "regenerate") {
        if (!takeAi()) return true;
        const row = await service.generate(id, { force: true });
        deps.invalidate(CACHE_PREFIX);
        deps.sendJson(res, 200, { ok: true, update: service.toAdmin(row) });
        return true;
      }
      if (method === "POST" && action === "split") {
        const atSha = typeof body.atSha === "string" ? body.atSha.trim() : "";
        const result = await service.split(id, atSha, actorId);
        deps.invalidate(CACHE_PREFIX);
        deps.sendJson(res, 200, { ok: true, earlier: service.toAdmin(result.earlier), later: service.toAdmin(result.later) });
        return true;
      }
    }
  } catch (error) {
    if (error instanceof ChangelogError) {
      deps.sendJson(res, error.message === "Update not found." ? 404 : 400, { error: error.message });
      return true;
    }
    if (idMatch?.[2] === "regenerate") {
      deps.sendJson(res, 502, { error: `Autopilot couldn't write this update: ${error instanceof Error ? error.message : String(error)}` });
      return true;
    }
    throw error;
  }
  deps.sendJson(res, 404, { error: "Not found" });
  return true;
}
