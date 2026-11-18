import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSidebarTagLive,
  parseSidebarTagCreate,
  parseSidebarTagPatch,
  selectActiveSidebarTags,
  SidebarTagError,
  type SidebarTagWindowRow,
} from "./sidebarTagRules.js";

describe("parseSidebarTagCreate", () => {
  it("fills in the preset label and colours for New and Beta", () => {
    const tag = parseSidebarTagCreate({ target: "team_control", kind: "new" });
    assert.equal(tag.label, "New");
    assert.equal(tag.color, "#5865f2");
    assert.equal(tag.enabled, true);
    assert.equal(tag.style, "solid");
    assert.equal(parseSidebarTagCreate({ target: "widgets", kind: "beta" }).label, "Beta");
  });

  it("accepts a full custom tag and normalises it", () => {
    const tag = parseSidebarTagCreate({
      target: " Team_Control/Kiosk ",
      kind: "custom",
      label: "  Hot   stuff ",
      color: "#FF7A00",
      textColor: "#fff",
      icon: "flame",
      style: "soft",
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2026-02-01T00:00:00Z",
      sort: 3,
    });
    assert.equal(tag.target, "team_control/kiosk");
    assert.equal(tag.label, "Hot stuff");
    assert.equal(tag.color, "#ff7a00");
    assert.equal(tag.textColor, "#fff");
    assert.equal(tag.icon, "flame");
    assert.equal(tag.style, "soft");
    assert.equal(tag.startsAt?.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(tag.sort, 3);
  });

  it("rejects bad input", () => {
    const base = { target: "tickets", kind: "custom", label: "Hot", color: "#ff7a00" };
    for (const bad of [
      { ...base, color: "orange" },
      { ...base, color: "#ff7a0" },
      { ...base, textColor: "url(x)" },
      { ...base, label: "" },
      { ...base, label: "   " },
      { ...base, label: "x".repeat(15) },
      { ...base, icon: "skull" },
      { ...base, style: "glow" },
      { ...base, kind: "hot" },
      { ...base, target: "Team Control" },
      { ...base, target: "a/b/c" },
      { ...base, target: "../etc" },
      { ...base, target: "" },
      { ...base, startsAt: "nope" },
      { ...base, startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" },
      { target: "tickets", kind: "custom", color: "#ff7a00" },
      { target: "tickets", kind: "custom", label: "Hot" },
    ]) {
      assert.throws(() => parseSidebarTagCreate(bad), SidebarTagError, JSON.stringify(bad));
    }
  });

  it("allows a 14 character label", () => {
    assert.equal(parseSidebarTagCreate({ target: "x", kind: "custom", label: "x".repeat(14), color: "#000" }).label.length, 14);
  });
});

describe("parseSidebarTagPatch", () => {
  const existing = parseSidebarTagCreate({ target: "tickets", kind: "custom", label: "Hot", color: "#ff7a00", icon: "flame" });

  it("merges a partial update and can clear nullable fields", () => {
    const next = parseSidebarTagPatch(existing, { enabled: false, icon: null, endsAt: "2027-01-01T00:00:00Z" });
    assert.equal(next.enabled, false);
    assert.equal(next.icon, null);
    assert.equal(next.label, "Hot");
    assert.equal(next.endsAt?.toISOString(), "2027-01-01T00:00:00.000Z");
  });

  it("checks the window against the stored values", () => {
    const scheduled = parseSidebarTagPatch(existing, { endsAt: "2027-01-01T00:00:00Z" });
    assert.throws(() => parseSidebarTagPatch(scheduled, { startsAt: "2028-01-01T00:00:00Z" }), SidebarTagError);
  });
});

describe("selectActiveSidebarTags", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const row = (id: number, target: string, extra: Partial<SidebarTagWindowRow> = {}): SidebarTagWindowRow => ({
    id,
    target,
    enabled: true,
    startsAt: null,
    endsAt: null,
    sort: 0,
    ...extra,
  });

  it("honours enabled and the start/end window", () => {
    assert.equal(isSidebarTagLive(row(1, "a"), now), true);
    assert.equal(isSidebarTagLive(row(1, "a", { enabled: false }), now), false);
    assert.equal(isSidebarTagLive(row(1, "a", { startsAt: new Date("2026-06-02T00:00:00Z") }), now), false);
    assert.equal(isSidebarTagLive(row(1, "a", { startsAt: new Date("2026-05-01T00:00:00Z") }), now), true);
    assert.equal(isSidebarTagLive(row(1, "a", { endsAt: now }), now), false);
    assert.equal(isSidebarTagLive(row(1, "a", { endsAt: new Date("2026-06-01T12:00:01Z") }), now), true);
  });

  it("keeps at most two per item, ordered by sort then id", () => {
    const picked = selectActiveSidebarTags(
      [
        row(1, "tickets", { sort: 5 }),
        row(2, "tickets", { sort: 1 }),
        row(3, "tickets", { sort: 1 }),
        row(4, "appeals"),
        row(5, "appeals", { endsAt: new Date("2026-01-01T00:00:00Z") }),
        row(6, "tickets", { sort: -1, enabled: false }),
      ],
      now,
    );
    assert.deepEqual(
      picked.map((tag) => tag.id),
      [4, 2, 3],
    );
  });
});
