import { test } from "node:test";
import assert from "node:assert/strict";
import { availablePlugins } from "../plugins/availablePlugins.js";

/**
 * Discord refuses the whole command registration when a bot has more than 100 top-level slash
 * commands (error 30032), so no command changes reach Discord at all. Catch it here instead of
 * at deploy: group new commands as subcommands (see `/info` in utility) rather than adding more.
 */
const DISCORD_SLASH_COMMAND_LIMIT = 100;

test("slash commands stay under Discord's limit of 100", () => {
  const names = availablePlugins.flatMap((plugin) => plugin.slashCommands.map((command) => command.data.name));
  assert.ok(
    names.length <= DISCORD_SLASH_COMMAND_LIMIT,
    `${names.length} top-level slash commands; Discord allows ${DISCORD_SLASH_COMMAND_LIMIT}. Group some as subcommands.`,
  );
  assert.equal(new Set(names).size, names.length, "two commands share a name");
});

test("/info keeps each lookup's own permission flag", () => {
  const info = availablePlugins.flatMap((plugin) => plugin.slashCommands).find((command) => command.data.name === "info");
  assert.ok(info);
  assert.equal(info.subcommandPermissions?.user, "can_userinfo");
  assert.equal(info.subcommandPermissions?.lookup, "can_info");
  assert.equal(info.subcommandPermissions?.snowflake, "can_snowflake");
  const json = info.data.toJSON() as { options: { name: string; type: number }[] };
  assert.deepEqual(
    json.options.map((option) => option.name).sort(),
    ["channel", "emoji", "invite", "lookup", "message", "role", "server", "snowflake", "user"],
  );
  assert.ok(json.options.every((option) => option.type === 1));
});
