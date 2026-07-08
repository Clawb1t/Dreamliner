/**
 * Panel / production entrypoint.
 * PebbleHost: set BOT START FILE to "main.js"
 * Also used by `npm start` so missing dist/ does not crash.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env: process.env });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync("dist/index.js")) {
  console.log("[dreamliner] dist/ missing — installing dependencies and building…");
  run("npm", ["install", "--include=dev"]);
  run("npm", ["run", "build"]);
}

if (!existsSync("dist/index.js")) {
  console.error("[dreamliner] Build finished but dist/index.js is still missing.");
  process.exit(1);
}

await import("./dist/index.js");
