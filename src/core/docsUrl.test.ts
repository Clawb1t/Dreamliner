import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getGuildCasesDashboardUrl,
  getGuildDashboardUrl,
  getGuildMemberHubUrl,
  getGuildTicketsDashboardUrl,
  getIdentityCardUrl,
} from "./docsUrl.js";
import { caseLogButtons } from "./logging/send.js";

const GUILD = "1537960888026402868";
const USER = "123456789012345678";
const base = getGuildDashboardUrl(GUILD);

test("cases URL opens the section, optionally on one case", () => {
  assert.equal(getGuildCasesDashboardUrl(GUILD), `${base}?section=cases`);
  assert.equal(getGuildCasesDashboardUrl(GUILD, 42), `${base}?section=cases&case=42`);
  assert.equal(getGuildCasesDashboardUrl(GUILD, null), `${base}?section=cases`);
  assert.equal(getGuildCasesDashboardUrl(GUILD, 0), `${base}?section=cases`);
  assert.equal(getGuildCasesDashboardUrl(GUILD, -3), `${base}?section=cases`);
});

test("tickets URL opens the section, optionally on one ticket", () => {
  assert.equal(getGuildTicketsDashboardUrl(GUILD), `${base}?section=tickets`);
  assert.equal(getGuildTicketsDashboardUrl(GUILD, 7), `${base}?section=tickets&ticket=7`);
  assert.equal(getGuildTicketsDashboardUrl(GUILD, "7"), `${base}?section=tickets&ticket=7`);
  assert.equal(getGuildTicketsDashboardUrl(GUILD, "7&x=1"), `${base}?section=tickets`);
});

test("member hub URL carries only a valid snowflake", () => {
  assert.equal(getGuildMemberHubUrl(GUILD, USER), `${base}?section=member&user=${USER}`);
  assert.equal(getGuildMemberHubUrl(GUILD, "abc"), `${base}?section=member`);
});

test("case logs link to the case and the target's identity card", () => {
  const buttons = caseLogButtons({ guildId: GUILD, eventType: "case_ban", caseId: 9, targetId: USER });
  assert.deepEqual(
    buttons.map((b) => b.url),
    [getGuildCasesDashboardUrl(GUILD, 9), getIdentityCardUrl(GUILD, USER)],
  );
  assert.ok(buttons.every((b) => b.emoji?.startsWith("<:")));
});

test("deleted cases and non-case events get no case buttons", () => {
  assert.deepEqual(caseLogButtons({ guildId: GUILD, eventType: "case_delete", caseId: 9, targetId: USER }), []);
  assert.deepEqual(caseLogButtons({ guildId: GUILD, eventType: "dm_failed", caseId: 9, targetId: USER }), []);
  assert.deepEqual(caseLogButtons({ guildId: GUILD, eventType: "case_warn", caseId: null, targetId: USER }), []);
  assert.equal(caseLogButtons({ guildId: GUILD, eventType: "case_warn", caseId: 3, targetId: null }).length, 1);
});
