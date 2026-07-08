/**
 * PebbleHost / Pterodactyl entrypoint.
 * Set BOT START FILE to: main.js
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env: process.env });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync("node_modules")) {
  console.log("[dreamliner] Installing dependencies…");
  run("npm", ["install"]);
}

console.log("[dreamliner] Building…");
run("npm", ["run", "build"]);

await import("./dist/index.js");
