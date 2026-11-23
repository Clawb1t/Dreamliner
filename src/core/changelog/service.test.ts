import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChangelogService } from "./service.js";
import { createMemoryChangelogStore } from "./store.js";
import { parseChangelogContent, type ChangelogCommit } from "./rules.js";

const c = (sha: string, date: string): ChangelogCommit => ({ sha, date, message: `Commit ${sha}`, areas: null });

const HISTORY = [
  c("a1", "2026-11-02T10:00:00Z"),
  c("a2", "2026-11-03T09:00:00Z"),
  c("b1", "2026-11-08T12:00:00Z"),
  c("b2", "2026-11-09T08:00:00Z"),
  c("c1", "2026-11-14T08:00:00Z"),
  c("c2", "2026-11-16T08:00:00Z"),
  c("d1", "2026-11-21T08:00:00Z"),
];

function content(name = "Ghost Mode") {
  return parseChangelogContent({
    title: "t",
    headline: [name],
    summary: "An update.",
    sections: [{ icon: "ghost", name, tagline: null, paragraphs: ["Something useful."], bullets: [] }],
    smallerImprovements: [],
  });
}

function setup(options: { now?: string; commits?: ChangelogCommit[]; backfillLimit?: number; empty?: boolean } = {}) {
  const store = createMemoryChangelogStore();
  let calls = 0;
  let commits = options.commits ?? HISTORY;
  const service = new ChangelogService({
    store,
    fetchCommits: async (since) => ({ commits: commits.filter((x) => since === null || Date.parse(x.date) >= since), source: "test" }),
    fillAreas: async (list) => list.map((x) => ({ ...x, areas: x.areas ?? [] })),
    generate: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return options.empty
        ? { content: parseChangelogContent({ title: "", headline: [], summary: "", sections: [], smallerImprovements: [] }), model: "test" }
        : { content: content(), model: "test" };
    },
    repoIsPublic: () => true,
    repo: "owner/repo",
    now: () => Date.parse(options.now ?? "2026-11-22T12:00:00Z"),
    windowOptions: { gapHours: 48, maxDays: 7 },
    backfillLimit: options.backfillLimit ?? 2,
  });
  return { store, service, calls: () => calls, setCommits: (list: ChangelogCommit[]) => (commits = list) };
}

describe("ChangelogService.sync", () => {
  it("backfills closed windows, generating only the newest few", async () => {
    const { store, service, calls } = setup();
    const result = await service.sync();
    // d1 (21 Nov) is still open on the 22nd.
    assert.equal(result.inserted, 3);
    assert.equal(result.generated, 2);
    assert.equal(calls(), 2);
    assert.deepEqual(result.openWindow?.commits, 1);
    const rows = await store.list();
    assert.deepEqual(rows.map((r) => [r.slug, r.status, Boolean(r.content)]), [
      ["2026-11-16", "published", true],
      ["2026-11-09", "published", true],
      ["2026-11-03", "draft", false],
    ]);
  });

  it("is idempotent: a second sync neither inserts nor regenerates", async () => {
    const { service, calls } = setup();
    await service.sync();
    const again = await service.sync();
    assert.equal(again.inserted, 0);
    assert.equal(again.generated, 0);
    assert.equal(calls(), 2);
  });

  it("shares one run between concurrent syncs and concurrent generations", async () => {
    const { store, service, calls } = setup({ backfillLimit: 1 });
    const [a, b] = await Promise.all([service.sync(), service.sync()]);
    assert.equal(a, b);
    assert.equal(calls(), 1);
    const [row] = await store.list();
    await Promise.all([service.generate(row!.id, { force: true }), service.generate(row!.id, { force: true })]);
    assert.equal(calls(), 2);
    // Not forced, already generated from these commits: no AI call.
    await service.generate(row!.id);
    assert.equal(calls(), 2);
  });

  it("publishes a window once it closes", async () => {
    const { store, service, setCommits } = setup();
    await service.sync();
    setCommits([...HISTORY, c("d2", "2026-11-22T08:00:00Z")]);
    const later = new ChangelogService({
      store,
      fetchCommits: async () => ({ commits: [...HISTORY, c("d2", "2026-11-22T08:00:00Z")], source: "test" }),
      fillAreas: async (l) => l,
      generate: async () => ({ content: content("Radio"), model: "test" }),
      repoIsPublic: () => false,
      repo: "owner/repo",
      now: () => Date.parse("2026-11-25T12:00:00Z"),
      windowOptions: { gapHours: 48, maxDays: 7 },
    });
    const result = await later.sync();
    assert.equal(result.inserted, 1);
    assert.equal(result.openWindow, null);
    const newest = (await store.list())[0]!;
    assert.equal(newest.slug, "2026-11-22");
    assert.deepEqual(newest.commits.map((x) => x.sha), ["d1", "d2"]);
    assert.equal(newest.status, "published");
  });

  it("hides a window with nothing user-facing", async () => {
    const { store, service } = setup({ empty: true, backfillLimit: 1 });
    await service.sync();
    assert.equal((await store.list())[0]!.status, "hidden");
  });
});

describe("ChangelogService public view", () => {
  it("only returns published updates with content, without commit details", async () => {
    const { store, service } = setup();
    await service.sync();
    const rows = await store.list();
    await service.edit(rows[1]!.id, { status: "hidden" }, "1");
    const list = await service.listPublic(1, 10);
    assert.deepEqual(list.updates.map((u) => u.slug), ["2026-11-16"]);
    assert.equal(list.total, 1);
    assert.equal(await service.getPublic("2026-11-09"), null); // hidden
    assert.equal(await service.getPublic("2026-11-03"), null); // draft, not generated
    const json = JSON.stringify(list);
    assert.ok(!json.includes("c1") && !json.includes("Commit "), "no commit hashes or messages");
    assert.equal(list.updates[0]!.changeCount, 2);
    assert.match(list.updates[0]!.githubUrl!, /since=2026-11-14&until=2026-11-17$/);
  });
});

describe("ChangelogService operator tools", () => {
  it("rejects invalid edits and publishing without content", async () => {
    const { store, service } = setup();
    await service.sync();
    const rows = await store.list();
    await assert.rejects(service.edit(rows[0]!.id, { content: { ...content(), sections: [{ icon: "nope" }] } }, "1"));
    await assert.rejects(service.edit(rows[2]!.id, { status: "published" }, "1"), /Generate this update/);
    const edited = await service.edit(rows[0]!.id, { content: content("Edited") }, "42");
    assert.equal(edited.content!.sections[0]!.name, "Edited");
    assert.equal(edited.editedBy, "42");
  });

  it("merges neighbours and splits them back", async () => {
    const { store, service } = setup();
    await service.sync();
    const [newest, middle, oldest] = await store.list();
    await assert.rejects(service.merge([newest!.id, oldest!.id], "1"), /neighbouring/);
    const merged = await service.merge([newest!.id, middle!.id], "1");
    assert.equal(merged.id, newest!.id);
    assert.equal(merged.slug, "2026-11-16");
    assert.equal(merged.status, "draft");
    assert.equal(merged.content, null);
    assert.deepEqual(merged.commits.map((x) => x.sha), ["b1", "b2", "c1", "c2"]);

    const { earlier, later } = await service.split(merged.id, "c1", "1");
    assert.deepEqual(earlier.commits.map((x) => x.sha), ["b1", "b2"]);
    assert.equal(earlier.slug, "2026-11-09");
    assert.deepEqual(later.commits.map((x) => x.sha), ["c1", "c2"]);
    await assert.rejects(service.split(later.id, "c1", "1"), /after the first/);
  });

  it("generate older writes and publishes drafts", async () => {
    const { store, service } = setup();
    await service.sync();
    const result = await service.generateOlder(3);
    assert.deepEqual(result, { generated: 1, failed: 0, remaining: 0 });
    assert.ok((await store.list()).every((r) => r.status === "published" && r.content));
  });
});
