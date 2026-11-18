import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTakeoverLive,
  parseTakeoverConfig,
  pickActiveTakeover,
  safeParseTakeoverConfig,
  sanitiseTakeoverUrl,
  TakeoverConfigError,
  type TakeoverWindowRow,
} from "./frontpageTakeoverConfig.js";

describe("sanitiseTakeoverUrl", () => {
  it("keeps http(s) URLs and site paths", () => {
    assert.equal(sanitiseTakeoverUrl("https://dreamliner.site/one"), "https://dreamliner.site/one");
    assert.equal(sanitiseTakeoverUrl("http://example.com"), "http://example.com/");
    assert.equal(sanitiseTakeoverUrl(" /dashboard "), "/dashboard");
  });

  it("rejects every other scheme and protocol-relative or odd URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:image/png;base64,AAAA",
      "vbscript:x",
      "ftp://example.com/file",
      "//evil.example",
      "/\\evil.example",
      "https://user:pass@example.com",
      "https://exa mple.com",
      "not a url",
      "",
    ]) {
      assert.equal(sanitiseTakeoverUrl(bad), null, bad);
    }
  });
});

describe("parseTakeoverConfig", () => {
  it("fills every default from an empty object", () => {
    const config = parseTakeoverConfig({});
    assert.equal(config.background.type, "gradient");
    assert.equal(config.background.gradient.stops.length, 3);
    assert.equal(config.text.align, "left");
    assert.equal(config.buttons.length, 0);
    assert.equal(config.effects.glow.enabled, false);
    assert.equal(config.layout.mode, "section");
  });

  it("accepts a full config and normalises the countdown date", () => {
    const config = parseTakeoverConfig({
      background: { type: "image", imageUrl: "https://cdn.example.com/bg.png", blur: 4, overlayOpacity: 40 },
      text: { kicker: "Launch", headline: [{ text: "Hangar is " }, { text: "live", accent: true }], align: "center" },
      buttons: [
        { label: "Open", url: "/hangar", style: "primary", icon: "rocket" },
        { label: "Docs", url: "https://dreamliner.site/helpcenter", style: "ghost", newTab: true },
      ],
      effects: { countdown: { enabled: true, targetAt: "2030-01-01T12:00:00+02:00", label: "Starts in" } },
    });
    assert.equal(config.background.imageUrl, "https://cdn.example.com/bg.png");
    assert.equal(config.text.headline[1]!.accent, true);
    assert.equal(config.buttons[1]!.newTab, true);
    assert.equal(config.effects.countdown.targetAt, "2030-01-01T10:00:00.000Z");
  });

  it("rejects unsafe URLs anywhere", () => {
    assert.throws(() => parseTakeoverConfig({ buttons: [{ label: "x", url: "javascript:alert(1)" }] }), TakeoverConfigError);
    assert.throws(() => parseTakeoverConfig({ background: { videoUrl: "data:video/mp4;base64,AA" } }), TakeoverConfigError);
    assert.throws(() => parseTakeoverConfig({ art: { type: "side", imageUrl: "//evil.example/a.png" } }), TakeoverConfigError);
  });

  it("rejects non-hex colours, so nothing can break out of an inline style", () => {
    assert.throws(() => parseTakeoverConfig({ text: { headlineColor: "red;background:url(x)" } }), TakeoverConfigError);
    assert.throws(() => parseTakeoverConfig({ background: { color: "rgb(0,0,0)" } }), TakeoverConfigError);
    assert.doesNotThrow(() => parseTakeoverConfig({ background: { color: "#0b1030cc" } }));
  });

  it("enforces limits and required pieces", () => {
    const button = { label: "B", url: "/" };
    assert.throws(() => parseTakeoverConfig({ buttons: [button, button, button, button] }), /buttons/);
    assert.throws(() => parseTakeoverConfig({ text: { headline: [{ text: "  " }] } }), /headline/);
    assert.throws(() => parseTakeoverConfig({ background: { type: "video" } }), /videoUrl/);
    assert.throws(() => parseTakeoverConfig({ art: { type: "float" } }), /art\.imageUrl/);
    assert.throws(() => parseTakeoverConfig({ effects: { countdown: { enabled: true } } }), /countdown/);
    assert.throws(() => parseTakeoverConfig({ effects: { glow: { intensity: 400 } } }), TakeoverConfigError);
    assert.throws(
      () =>
        parseTakeoverConfig({
          background: { gradient: { stops: [{ color: "#000", position: 80 }, { color: "#fff", position: 10 }] } },
        }),
      /order/,
    );
  });

  it("safeParse returns null instead of throwing", () => {
    assert.equal(safeParseTakeoverConfig({ buttons: "nope" }), null);
    assert.ok(safeParseTakeoverConfig({}));
  });
});

describe("pickActiveTakeover", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const row = (id: number, patch: Partial<TakeoverWindowRow> = {}): TakeoverWindowRow => ({
    id,
    enabled: true,
    priority: 0,
    startsAt: null,
    endsAt: null,
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...patch,
  });

  it("returns null when nothing is live", () => {
    assert.equal(pickActiveTakeover([], now), null);
    assert.equal(pickActiveTakeover([row(1, { enabled: false })], now), null);
  });

  it("respects the window: future starts and past ends are skipped, open ends mean always", () => {
    assert.equal(isTakeoverLive(row(1, { startsAt: new Date("2026-06-02T00:00:00Z") }), now), false);
    assert.equal(isTakeoverLive(row(1, { endsAt: new Date("2026-06-01T11:59:59Z") }), now), false);
    assert.equal(isTakeoverLive(row(1, { endsAt: now }), now), false);
    assert.equal(isTakeoverLive(row(1, { startsAt: now }), now), true);
    assert.equal(
      isTakeoverLive(row(1, { startsAt: new Date("2026-05-01T00:00:00Z"), endsAt: new Date("2026-07-01T00:00:00Z") }), now),
      true,
    );
  });

  it("picks the highest priority live one", () => {
    const picked = pickActiveTakeover(
      [
        row(1, { priority: 5 }),
        row(2, { priority: 50, enabled: false }),
        row(3, { priority: 20 }),
        row(4, { priority: 90, startsAt: new Date("2026-07-01T00:00:00Z") }),
        row(5, { priority: 80, endsAt: new Date("2026-05-15T00:00:00Z") }),
      ],
      now,
    );
    assert.equal(picked?.id, 3);
  });

  it("breaks priority ties by the most recent edit, then the newest id", () => {
    const older = row(1, { priority: 10, updatedAt: new Date("2026-05-01T00:00:00Z") });
    const newer = row(2, { priority: 10, updatedAt: new Date("2026-05-20T00:00:00Z") });
    assert.equal(pickActiveTakeover([newer, older], now)?.id, 2);
    assert.equal(pickActiveTakeover([row(7, { priority: 1 }), row(9, { priority: 1 })], now)?.id, 9);
  });
});
