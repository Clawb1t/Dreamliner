import { test } from "node:test";
import assert from "node:assert/strict";
import { zWelcomeMessageConfig } from "../../../config/schemas/welcome.js";
import { applyWelcomeBack } from "./handlers.js";

test("welcome back is off by default and changes nothing", () => {
  const config = zWelcomeMessageConfig.parse({});
  assert.equal(config.welcome_back.enabled, false);
  assert.equal(applyWelcomeBack(config.join, "join", config, true), config.join);
});

test("returning member gets the welcome back body in the join channel", () => {
  const config = zWelcomeMessageConfig.parse({
    join: { enabled: true, channel_id: "123", content: "Welcome {user}!" },
    welcome_back: { enabled: true, message: { content: "Welcome back {user}!" } },
  });
  const event = applyWelcomeBack(config.join, "join", config, true);
  assert.equal(event.content, "Welcome back {user}!");
  assert.equal(event.channel_id, "123");
  assert.equal(event.enabled, true);
  // First-timers keep the normal welcome.
  assert.equal(applyWelcomeBack(config.join, "join", config, false).content, "Welcome {user}!");
  // DMs and leave messages are untouched.
  assert.equal(applyWelcomeBack(config.dm, "dm", config, true), config.dm);
});

test("default welcome back message has text and a card greeting", () => {
  const config = zWelcomeMessageConfig.parse({ welcome_back: { enabled: true } });
  assert.match(config.welcome_back.message.content, /Welcome back/);
  assert.match(config.welcome_back.message.card.greeting_text, /Welcome back/);
});
