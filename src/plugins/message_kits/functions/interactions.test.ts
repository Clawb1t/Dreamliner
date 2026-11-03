import assert from "node:assert/strict";
import test from "node:test";
import { formPingRole, parseKitCustomId, parseKitFormId } from "./interactions.js";

const GUILD_ID = "100000000000000000";
const ROLE_ID = "200000000000000000";
const guild = { id: GUILD_ID, roles: { cache: new Map([[GUILD_ID, {}], [ROLE_ID, {}]]) } } as unknown as Parameters<typeof formPingRole>[0];

test("form pings never reach @everyone and need the setting plus an existing role", () => {
  assert.equal(formPingRole(guild, true, ROLE_ID), ROLE_ID);
  // The @everyone role's id is the server's id; <@&id> of it must never be sent.
  assert.equal(formPingRole(guild, true, GUILD_ID), null);
  assert.equal(formPingRole(guild, false, ROLE_ID), null);
  assert.equal(formPingRole(guild, true, "300000000000000000"), null);
  assert.equal(formPingRole(guild, true, null), null);
});

test("kit custom ids only parse in their exact shape", () => {
  assert.deepEqual(parseKitCustomId("mk:12:btn-1"), { kitId: 12, componentId: "btn-1" });
  assert.equal(parseKitCustomId("mk:12:btn-1:extra"), null);
  assert.equal(parseKitCustomId("mk:../1:x"), null);
  assert.deepEqual(parseKitFormId("mk:f:3:menu:opt"), { kitId: 3, componentId: "menu", optionId: "opt" });
  assert.equal(parseKitFormId("mk:f:3:Menu"), null);
});
