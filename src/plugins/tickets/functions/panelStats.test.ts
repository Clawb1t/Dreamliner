import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zPersistEmbedConfig } from "../../../config/schemas/persist.js";
import { keysReferencedInPanel } from "./panelStats.js";

function panel(overrides: { content?: string; embed?: Partial<ReturnType<typeof zPersistEmbedConfig.parse>> }) {
  return {
    content: overrides.content ?? "",
    embed: zPersistEmbedConfig.parse({ ...overrides.embed }),
  };
}

describe("keysReferencedInPanel", () => {
  it("finds nothing in plain, placeholder-free text", () => {
    assert.deepEqual(keysReferencedInPanel(panel({ content: "Need help? Open a ticket below." })), []);
  });

  it("finds a placeholder used in the message content", () => {
    assert.deepEqual(keysReferencedInPanel(panel({ content: "Avg reply time: {avg_response_time}" })), [
      "avg_response_time",
    ]);
  });

  it("finds a placeholder used in the embed description", () => {
    const result = keysReferencedInPanel(panel({ embed: { description: "Resolved in {avg_resolution_time} on average." } }));
    assert.deepEqual(result, ["avg_resolution_time"]);
  });

  it("finds a placeholder used in an embed field", () => {
    const result = keysReferencedInPanel(
      panel({ embed: { fields: [{ name: "Response time", value: "{avg_response_time}" }] } }),
    );
    assert.deepEqual(result, ["avg_response_time"]);
  });

  it("finds both keys when both are referenced, without duplicates", () => {
    const result = keysReferencedInPanel(
      panel({
        content: "{avg_response_time} / {avg_response_time}",
        embed: { footer_text: "Resolution: {avg_resolution_time}" },
      }),
    );
    assert.deepEqual(result.sort(), ["avg_resolution_time", "avg_response_time"]);
  });

  it("does not match a partial or malformed token", () => {
    assert.deepEqual(keysReferencedInPanel(panel({ content: "avg_response_time without braces" })), []);
    assert.deepEqual(keysReferencedInPanel(panel({ content: "{avg_response_tim}" })), []);
  });
});
