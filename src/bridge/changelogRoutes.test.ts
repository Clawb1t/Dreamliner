import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { handleChangelogRoute, type ChangelogRouteDeps } from "./changelogRoutes.js";
import { ChangelogService } from "../core/changelog/service.js";
import { createMemoryChangelogStore, type ChangelogRow } from "../core/changelog/store.js";
import { parseChangelogContent } from "../core/changelog/rules.js";

const SUPERUSER = "272397639855898624";

function row(id: number, slug: string, status: ChangelogRow["status"], withContent = true): ChangelogRow {
  const t = Date.parse(`${slug}T12:00:00Z`);
  return {
    id,
    slug,
    windowStart: t - 86_400_000,
    windowEnd: t,
    commits: [{ sha: `deadbeef${id}`, date: new Date(t).toISOString(), message: "Secret internal message", areas: [] }],
    content: withContent
      ? parseChangelogContent({
          title: `Update ${slug}`,
          headline: ["Radio"],
          summary: "An update.",
          sections: [{ icon: "music", name: "Radio", tagline: null, paragraphs: ["Listen live."], bullets: [] }],
          smallerImprovements: [],
        })
      : null,
    status,
    model: "test",
    generatedFor: null,
    generatedAt: t,
    generationError: null,
    editedBy: null,
    editedAt: null,
    createdAt: t,
    updatedAt: t,
  };
}

function harness() {
  const store = createMemoryChangelogStore([
    row(1, "2026-11-20", "published"),
    row(2, "2026-11-10", "hidden"),
    row(3, "2026-11-05", "draft"),
    row(4, "2026-11-01", "published", false),
  ]);
  const service = new ChangelogService({
    store,
    fetchCommits: async () => ({ commits: [], source: "test" }),
    fillAreas: async (l) => l,
    generate: async () => {
      throw new Error("no AI in tests");
    },
    repoIsPublic: () => false,
    repo: "o/r",
  });
  const deps: ChangelogRouteDeps = {
    getService: async () => service,
    readBody: async (req) => (req as unknown as { body: string }).body ?? "",
    sendJson: (res, status, body) => {
      (res as unknown as { result: unknown }).result = { status, body };
    },
    isSuperuser: (id) => id === SUPERUSER,
    cached: (_key, _ttl, compute) => compute(),
    invalidate: () => {},
  };
  async function call(method: string, path: string, body?: unknown) {
    const req = { method, body: body === undefined ? "" : JSON.stringify(body) } as unknown as http.IncomingMessage;
    const res = { setHeader() {}, result: null } as unknown as http.ServerResponse & { result: { status: number; body: any } | null };
    const handled = await handleChangelogRoute(req, res, new URL(`http://x${path}`), deps);
    return { handled, ...(res.result ?? { status: 0, body: null }) };
  }
  return { call, store };
}

describe("changelog public routes", () => {
  it("lists only published updates that have content", async () => {
    const { call } = harness();
    const { status, body } = await call("GET", "/bridge/public/changelog");
    assert.equal(status, 200);
    assert.deepEqual(body.updates.map((u: { slug: string }) => u.slug), ["2026-11-20"]);
    assert.equal(body.total, 1);
    const json = JSON.stringify(body);
    assert.ok(!json.includes("deadbeef") && !json.includes("Secret internal"), "never exposes commits");
  });

  it("serves one published update by slug and 404s the rest", async () => {
    const { call } = harness();
    assert.equal((await call("GET", "/bridge/public/changelog/2026-11-20")).status, 200);
    assert.equal((await call("GET", "/bridge/public/changelog/2026-11-10")).status, 404);
    assert.equal((await call("GET", "/bridge/public/changelog/2026-11-05")).status, 404);
    assert.equal((await call("GET", "/bridge/public/changelog/..%2Fetc")).status, 404);
    assert.equal((await call("POST", "/bridge/public/changelog")).status, 405);
  });

  it("leaves other routes alone", async () => {
    const { call } = harness();
    assert.equal((await call("GET", "/bridge/public/sidebar-tags")).handled, false);
  });
});

describe("changelog operator routes", () => {
  it("require a superuser", async () => {
    const { call } = harness();
    assert.equal((await call("GET", "/bridge/platform/changelog?userId=123456789012345678")).status, 403);
    assert.equal((await call("GET", "/bridge/platform/changelog")).status, 403);
    assert.equal((await call("PUT", "/bridge/platform/changelog/1", { userId: "123456789012345678", status: "hidden" })).status, 403);
    assert.equal((await call("POST", "/bridge/platform/changelog/check", {})).status, 403);
    assert.equal((await call("POST", "/bridge/platform/changelog/merge", { userId: "nope", ids: [1, 2] })).status, 403);
  });

  it("let a superuser list, hide and see every status", async () => {
    const { call, store } = harness();
    const list = await call("GET", `/bridge/platform/changelog?userId=${SUPERUSER}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.updates.length, 4);
    assert.equal(list.body.updates[0].commits[0].subject, "Secret internal message");
    const hide = await call("PUT", "/bridge/platform/changelog/1", { userId: SUPERUSER, status: "hidden" });
    assert.equal(hide.status, 200);
    assert.equal((await store.get(1))!.status, "hidden");
    assert.equal((await call("PUT", "/bridge/platform/changelog/99", { userId: SUPERUSER, status: "hidden" })).status, 404);
    assert.equal((await call("PUT", "/bridge/platform/changelog/1", { userId: SUPERUSER, status: "live" })).status, 400);
  });

  it("report an Autopilot failure on regenerate as 502", async () => {
    const { call } = harness();
    const res = await call("POST", "/bridge/platform/changelog/1/regenerate", { userId: SUPERUSER });
    assert.equal(res.status, 502);
  });
});
