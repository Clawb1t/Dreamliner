/**
 * PebbleHost / Pterodactyl entrypoint.
 * Set BOT START FILE to: main.js
 */
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env: process.env });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Always include devDependencies so `tsc` is available even if NODE_ENV=production.
console.log("[dreamliner] Installing dependencies…");
run("npm", ["install", "--include=dev"]);

console.log("[dreamliner] Building…");
run("npm", ["run", "build"]);

await import("./dist/index.js");
