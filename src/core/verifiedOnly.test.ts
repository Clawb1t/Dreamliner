import { test } from "node:test";
import assert from "node:assert/strict";
import type { GuildMember } from "discord.js";
import { checkPassportRequirement, passportRequiredMessage, type PassportStatus } from "./verifiedOnly.js";
import { defaultTranslator } from "../i18n/index.js";

const member = { id: "1", guild: { id: "g" } } as unknown as GuildMember;
const status = (s: PassportStatus | null) => async () => s;

test("requirement off never looks Passport up", async () => {
  let called = false;
  const result = await checkPassportRequirement(member, false, defaultTranslator, async () => {
    called = true;
    return null;
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(called, false);
});

test("passed member (or Passport off / bypass) is allowed", async () => {
  const result = await checkPassportRequirement(
    member,
    true,
    defaultTranslator,
    status({ passed: true, verifyUrl: "", channelId: "" }),
  );
  assert.deepEqual(result, { ok: true });
});

test("Passport failing to load ignores the requirement", async () => {
  assert.deepEqual(await checkPassportRequirement(member, true, defaultTranslator, status(null)), { ok: true });
});

test("unverified member is refused with how to verify", async () => {
  const result = await checkPassportRequirement(
    member,
    true,
    defaultTranslator,
    status({ passed: false, verifyUrl: "https://example.test/passport/g", channelId: "123" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /<#123>/);
  assert.match(result.message, /https:\/\/example\.test\/passport\/g/);
  assert.match(result.message, /^<:icons_verified:\d+>/);
  assert.doesNotMatch(result.message, /—/);
});

test("no verify channel falls back to the link only", () => {
  const message = passportRequiredMessage(defaultTranslator, { verifyUrl: "https://x.test/p", channelId: "" });
  assert.doesNotMatch(message, /<#/);
  assert.match(message, /Verify here: https:\/\/x\.test\/p/);
});
