import { test } from "node:test";
import assert from "node:assert/strict";
import { zAppealsConfig, type AppealsConfig } from "../../../config/schemas/appeals.js";
import { appealOptions, snowflakeDate, type CaseLike } from "./eligibility.js";
import type { AppealRecord } from "./store.js";

const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 9, 9, 12));
const ago = (days: number) => new Date(now.getTime() - days * DAY);

const config = (patch: Record<string, unknown> = {}): AppealsConfig => zAppealsConfig.parse(patch);

const infraction = (patch: Partial<CaseLike> = {}): CaseLike => ({
  id: 1,
  type: "ban",
  reason: "Spam",
  modId: "9",
  active: true,
  createdAt: ago(1),
  expiresAt: null,
  ...patch,
});

const appeal = (patch: Partial<AppealRecord> = {}): AppealRecord => ({
  id: 100,
  guildId: "g",
  userId: "u",
  caseId: 1,
  kind: "case",
  infractionType: "ban",
  caseSnapshot: null,
  option: null,
  formId: "",
  formName: "",
  answers: [],
  status: "pending",
  reviewerId: null,
  decisionReason: null,
  reversed: false,
  reversalNote: null,
  reviewChannelId: null,
  reviewMessageId: null,
  threadId: null,
  createdAt: ago(1),
  updatedAt: ago(1),
  decidedAt: null,
  ...patch,
});

const viewer = { userId: "u", isBanned: true, isMember: false, accountCreatedAt: ago(400), memberRoleIds: [] };

test("an active ban is appealable straight away by default", () => {
  const result = appealOptions(config(), [infraction()], [], now, viewer);
  assert.equal(result.cases[0]?.state, "appealable");
  assert.equal(result.block, null);
});

test("types the server doesn't take appeals for are hidden", () => {
  const result = appealOptions(config(), [infraction({ type: "kick" }), infraction({ id: 2, type: "note" })], [], now, viewer);
  assert.equal(result.cases.length, 0);
});

test("minimum wait and appeal window", () => {
  const waiting = appealOptions(config({ types: { ban: { min_wait: "3d" } } }), [infraction()], [], now, viewer);
  assert.equal(waiting.cases[0]?.state, "wait");
  assert.equal(waiting.cases[0]?.until?.getTime(), ago(1).getTime() + 3 * DAY);
  const closed = appealOptions(config({ types: { ban: { window: "7d" } } }), [infraction({ createdAt: ago(10) })], [], now, viewer);
  assert.equal(closed.cases[0]?.state, "window_closed");
});

test("lifted infractions need allow_inactive, but kicks never count as lifted", () => {
  assert.equal(appealOptions(config(), [infraction({ active: false })], [], now, viewer).cases[0]?.state, "inactive");
  assert.equal(
    appealOptions(config({ types: { ban: { allow_inactive: true } } }), [infraction({ active: false })], [], now, viewer).cases[0]?.state,
    "appealable",
  );
  assert.equal(
    appealOptions(config({ types: { kick: { enabled: true } } }), [infraction({ type: "kick", active: false })], [], now, viewer).cases[0]?.state,
    "appealable",
  );
});

test("open, approved, maxed and cooling-down appeals", () => {
  const open = appealOptions(config(), [infraction()], [appeal()], now, viewer);
  assert.deepEqual([open.cases[0]?.state, open.cases[0]?.appealId], ["already_open", 100]);
  assert.equal(appealOptions(config(), [infraction()], [appeal({ status: "approved" })], now, viewer).cases[0]?.state, "resolved");

  const denied = appeal({ status: "denied", decidedAt: ago(2) });
  const cooling = appealOptions(config(), [infraction({ createdAt: ago(5) })], [denied], now, viewer);
  assert.equal(cooling.cases[0]?.state, "cooldown");
  assert.equal(cooling.cases[0]?.until?.getTime(), ago(2).getTime() + 30 * DAY);

  const twice = [denied, appeal({ id: 101, status: "denied", decidedAt: ago(60) })];
  assert.equal(appealOptions(config(), [infraction()], twice, now, viewer).cases[0]?.state, "max_reached");
  // Withdrawn appeals don't use up a try.
  assert.equal(
    appealOptions(config({ limits: { deny_cooldown: "" } }), [infraction()], [denied, appeal({ id: 102, status: "withdrawn" })], now, viewer)
      .cases[0]?.state,
    "appealable",
  );
});

test("manual appeals: off by default, and only for banned users when required", () => {
  assert.equal(appealOptions(config(), [], [], now, viewer).manual.state, "disabled");
  const on = config({ manual: { enabled: true } });
  assert.equal(appealOptions(on, [], [], now, viewer).manual.state, "appealable");
  assert.equal(appealOptions(on, [], [], now, { ...viewer, isBanned: false }).manual.state, "not_banned");
  assert.equal(
    appealOptions(on, [], [appeal({ caseId: null, kind: "manual" })], now, viewer).manual.state,
    "already_open",
  );
});

test("custom options: own history per option, require_ban, disabled ones hidden", () => {
  const cfg = config({
    custom_options: [
      { id: "minecraft", label: "Minecraft ban" },
      { id: "discord-only", label: "Banned here", require_ban: true },
      { id: "off", label: "Hidden", enabled: false },
    ],
  });
  const fresh = appealOptions(cfg, [], [], now, { ...viewer, isBanned: false });
  assert.deepEqual(
    fresh.custom.map((option) => [option.id, option.state]),
    [
      ["minecraft", "appealable"],
      ["discord-only", "not_banned"],
    ],
  );

  const pendingMinecraft = appeal({ kind: "manual", caseId: null, infractionType: null, option: { id: "minecraft", label: "Minecraft ban" } });
  const result = appealOptions(cfg, [], [pendingMinecraft], now, viewer);
  assert.equal(result.custom.find((option) => option.id === "minecraft")?.state, "already_open");
  assert.equal(result.custom.find((option) => option.id === "discord-only")?.state, "appealable");
  // A custom-option appeal doesn't count against the built-in manual appeal.
  const manual = appealOptions(config({ manual: { enabled: true }, custom_options: [{ id: "minecraft", label: "Minecraft ban" }] }), [], [pendingMinecraft], now, viewer);
  assert.equal(manual.manual.state, "appealable");
});

test("custom option ids must be unique and slug-shaped", () => {
  assert.throws(() => config({ custom_options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }));
  assert.throws(() => config({ custom_options: [{ id: "Has Spaces", label: "A" }] }));
});

test("blocks: listed users, blocked roles, new accounts, too many open appeals", () => {
  assert.deepEqual(appealOptions(config({ limits: { blocked_users: ["u"] } }), [], [], now, viewer).block, { kind: "blocked" });
  assert.deepEqual(
    appealOptions(config({ limits: { blocked_roles: ["r"] } }), [], [], now, { ...viewer, isMember: true, memberRoleIds: ["r"] }).block,
    { kind: "blocked" },
  );
  assert.equal(
    appealOptions(config({ limits: { min_account_age: "30d" } }), [], [], now, { ...viewer, accountCreatedAt: ago(3) }).block?.kind,
    "account_too_new",
  );
  assert.deepEqual(appealOptions(config(), [infraction()], [appeal()], now, viewer).block, { kind: "too_many_open", max: 1 });
});

test("account age from a Discord id", () => {
  assert.equal(snowflakeDate("175928847299117063").toISOString(), "2016-04-30T11:18:25.796Z");
});
