import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zGuildConfig } from "../../../config/schemas/guild.js";
import { automatedDmNotifyKey, planAutomatedDm } from "./automatedNotify.js";

type Overrides = { appeals?: Record<string, unknown> | false; notify?: Record<string, unknown> };

function guildConfig({ appeals, notify }: Overrides = {}) {
  const plugins: Record<string, unknown> = {};
  if (appeals !== false) plugins.appeals = { enabled: true, config: appeals ?? {} };
  if (notify) plugins.infractions = { enabled: true, config: { notify } };
  return zGuildConfig.parse({ plugins });
}

describe("automatedDmNotifyKey", () => {
  const notify = {
    warn: { dm: true },
    mute: { dm: true },
    tempmute: { dm: true },
    kick: { dm: true },
    ban: { dm: false },
    tempban: { dm: true },
    softban: { dm: true },
  };
  it("uses the type's own DM row, falling back to the base type", () => {
    assert.equal(automatedDmNotifyKey("tempmute", notify), "tempmute");
    assert.equal(automatedDmNotifyKey("kick", notify), "kick");
  });
  it("returns null when the server turned that DM off or the type never DMs", () => {
    assert.equal(automatedDmNotifyKey("ban", notify), null);
    assert.equal(automatedDmNotifyKey("note", notify), null);
    assert.equal(automatedDmNotifyKey("unban", notify), null);
  });
});

describe("planAutomatedDm appeal button", () => {
  it("adds the Appeal button when Appeals is on and the type is appealable", async () => {
    const plan = await planAutomatedDm(guildConfig(), "1", { id: 5, type: "ban" });
    assert.ok(plan);
    assert.equal(plan.components.length, 1);
  });

  it("omits the button when the Appeals plugin is off", async () => {
    const config = guildConfig({ appeals: false });
    config.plugins.appeals = { ...(config.plugins.appeals ?? {}), enabled: false } as typeof config.plugins.appeals;
    const plan = await planAutomatedDm(config, "1", { id: 5, type: "ban" });
    assert.ok(plan);
    assert.equal(plan.components.length, 0);
  });

  it("omits the button for a type Appeals doesn't allow (softban off by default)", async () => {
    const plan = await planAutomatedDm(guildConfig(), "1", { id: 5, type: "softban" });
    assert.ok(plan);
    assert.equal(plan.components.length, 0);
  });

  it("omits the button when appeals are paused or the DM button is off", async () => {
    const paused = await planAutomatedDm(guildConfig({ appeals: { accepting: false } }), "1", { id: 5, type: "ban" });
    assert.equal(paused?.components.length, 0);
    const noButton = await planAutomatedDm(guildConfig({ appeals: { dm_button: { enabled: false } } }), "1", {
      id: 5,
      type: "ban",
    });
    assert.equal(noButton?.components.length, 0);
  });

  it("sends nothing when the server's DM setting for that type is off", async () => {
    const config = guildConfig({ notify: { ban: { dm: false } } });
    assert.equal(await planAutomatedDm(config, "1", { id: 5, type: "ban" }), null);
  });
});
