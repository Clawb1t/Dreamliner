import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  areaFromPath,
  buildUpdateTitle,
  cleanChangelogText,
  commitSetKey,
  contentLeaks,
  dropLeakyLines,
  findLeaks,
  toUkSpelling,
  groupCommitsIntoWindows,
  isWindowClosed,
  parseChangelogContent,
  promptCommitMessage,
  uniqueSlug,
  windowOptionsFromEnv,
  ChangelogError,
  type ChangelogCommit,
} from "./rules.js";

const c = (sha: string, date: string, message = sha): ChangelogCommit => ({ sha, date, message, areas: null });
const OPTS = { gapHours: 48, maxDays: 7 };

describe("groupCommitsIntoWindows", () => {
  it("splits on a quiet gap longer than the threshold", () => {
    const windows = groupCommitsIntoWindows(
      [c("a", "2026-11-02T10:00:00Z"), c("b", "2026-11-03T09:00:00Z"), c("c", "2026-11-08T12:00:00Z"), c("d", "2026-11-09T08:00:00Z")],
      OPTS,
    );
    assert.deepEqual(windows.map((w) => w.commits.map((x) => x.sha)), [["a", "b"], ["c", "d"]]);
  });

  it("sorts input and caps a busy window at maxDays", () => {
    const daily = Array.from({ length: 10 }, (_, i) => c(`d${i}`, `2026-09-${String(11 + i).padStart(2, "0")}T12:00:00Z`)).reverse();
    const windows = groupCommitsIntoWindows(daily, OPTS);
    assert.equal(windows.length, 2);
    assert.equal(windows[0]!.commits[0]!.sha, "d0");
    assert.equal(windows[0]!.commits.length, 8); // 11th..18th: the 19th is more than 7 days after the start
    assert.equal(windows[1]!.commits.length, 2);
  });

  it("keeps a gap of exactly the threshold in the same window", () => {
    const windows = groupCommitsIntoWindows([c("a", "2026-11-01T00:00:00Z"), c("b", "2026-11-03T00:00:00Z")], OPTS);
    assert.equal(windows.length, 1);
  });

  it("only closes the last window once it has been quiet for the threshold", () => {
    const [w] = groupCommitsIntoWindows([c("a", "2026-11-21T10:00:00Z")], OPTS);
    const t = Date.parse("2026-11-21T10:00:00Z");
    assert.equal(isWindowClosed(w!, true, t + 47 * 3_600_000, OPTS), false);
    assert.equal(isWindowClosed(w!, true, t + 49 * 3_600_000, OPTS), true);
    assert.equal(isWindowClosed(w!, false, t, OPTS), true);
  });

  it("reads thresholds from env with sane fallbacks", () => {
    assert.deepEqual(windowOptionsFromEnv({}), { gapHours: 48, maxDays: 7 });
    assert.deepEqual(windowOptionsFromEnv({ CHANGELOG_WINDOW_GAP_HOURS: "24", CHANGELOG_WINDOW_MAX_DAYS: "nope" }), { gapHours: 24, maxDays: 7 });
  });
});

describe("slugs, titles and keys", () => {
  it("dates the update in UK time and de-duplicates slugs", () => {
    const end = Date.parse("2026-11-20T23:30:00Z"); // still the 20th in London (GMT)
    assert.equal(uniqueSlug(end, () => false), "2026-11-20");
    assert.equal(uniqueSlug(end, (s) => s === "2026-11-20"), "2026-11-20-2");
    assert.equal(buildUpdateTitle(end, ["Notifications 2.0", "Ghost Mode", "The Hangar"], true), "Dreamliner Update 20/11/2026 - Notifications 2.0, Ghost Mode, The Hangar and more");
    assert.equal(buildUpdateTitle(end, ["Radio", "Avia"], false), "Dreamliner Update 20/11/2026 - Radio and Avia");
  });

  it("keys a commit set independent of order", () => {
    assert.equal(commitSetKey(["b", "a"]), commitSetKey(["a", "b"]));
    assert.notEqual(commitSetKey(["a"]), commitSetKey(["a", "b"]));
  });
});

const validSection = { icon: "ghost", name: "Ghost Mode", tagline: "Take control of your visibility.", paragraphs: ["Hide live activity."], bullets: [] };
const valid = { title: "x", headline: ["Ghost Mode"], summary: "A privacy update.", sections: [validSection], smallerImprovements: ["Faster pages"] };

describe("parseChangelogContent", () => {
  it("accepts valid output", () => {
    const content = parseChangelogContent(valid);
    assert.equal(content.sections[0]!.icon, "ghost");
    assert.equal(content.sections[0]!.tagline, "Take control of your visibility.");
  });

  it("rejects an icon outside the allowed list", () => {
    assert.throws(() => parseChangelogContent({ ...valid, sections: [{ ...validSection, icon: "rocket" }] }), ChangelogError);
  });

  it("strips em dashes, emoji and Discord markup", () => {
    const content = parseChangelogContent({
      ...valid,
      summary: "A big update — with **more** control :icons_spark: \u{1F680}",
      sections: [{ ...validSection, name: "Ghost–Mode", bullets: ["`Faster` pages—everywhere"] }],
    });
    assert.equal(content.summary, "A big update, with more control");
    assert.equal(content.sections[0]!.name, "Ghost-Mode");
    assert.equal(content.sections[0]!.bullets[0], "Faster pages-everywhere");
    assert.equal(cleanChangelogText("Hello — world"), "Hello, world");
  });

  it("rejects a section with nothing in it", () => {
    assert.throws(() => parseChangelogContent({ ...valid, sections: [{ ...validSection, paragraphs: ["  "], bullets: [] }] }), ChangelogError);
  });

  it("turns an empty tagline into null", () => {
    assert.equal(parseChangelogContent({ ...valid, sections: [{ ...validSection, tagline: "" }] }).sections[0]!.tagline, null);
  });
});

describe("leak checks", () => {
  it("finds and drops internal details", () => {
    const content = parseChangelogContent({
      ...valid,
      smallerImprovements: ["Faster pages", "Fixed src/bridge/webAi.ts", "Set OPENAI_API_KEY", "Reverted 790af78"],
    });
    assert.deepEqual(contentLeaks(content).sort(), ["code identifier", "commit hash", "environment variable", "file name", "file path", "internal jargon"]);
    assert.deepEqual(dropLeakyLines(content).smallerImprovements, ["Faster pages"]);
  });

  it("flags camelCase identifiers and internal jargon but not brand names", () => {
    assert.deepEqual(findLeaks("Updated webSwitch integration"), ["code identifier"]);
    assert.deepEqual(findLeaks("New dashboard bridge routes"), ["internal jargon"]);
    assert.deepEqual(findLeaks("YouTube, Twitch and Dreamliner One with Autopilot"), []);
  });
});

describe("UK spelling", () => {
  it("normalises common US spellings and keeps case", () => {
    assert.equal(toUkSpelling("Localized colors, organize Behavior"), "Localised colours, organise Behaviour");
    assert.equal(toUkSpelling("Resize the prize"), "Resize the prize");
    assert.equal(cleanChangelogText("Customize the catalog"), "Customise the catalogue");
  });
});

describe("commit preparation", () => {
  it("maps changed files to product areas and ignores the rest", () => {
    assert.equal(areaFromPath("src/plugins/tickets/functions/x.ts"), "Tickets");
    assert.equal(areaFromPath("src/bridge/webHangar.ts"), "The Hangar");
    assert.equal(areaFromPath("src/core/ai/client.ts"), "Autopilot");
    assert.equal(areaFromPath("drizzle/migrations/0159_x.sql"), null);
    assert.equal(areaFromPath("src/plugins/tickets/x.test.ts"), null);
  });

  it("drops trailers and emails from commit messages", () => {
    assert.equal(promptCommitMessage("Add thing\n\nBody text\nCo-Authored-By: A <a@b.com>"), "Add thing\nBody text");
  });
});
