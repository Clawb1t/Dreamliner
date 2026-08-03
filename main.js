/**
 * Panel / production entrypoint.
 * PebbleHost: set BOT START FILE to "main.js"
 *
 * Always prefers fresh builds: if you upload new `src/` files, the next
 * restart rebuilds `dist/` instead of running stale compiled output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env: process.env });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function newestMtime(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;

  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

function needsInstall() {
  if (!existsSync("node_modules")) return true;
  if (!existsSync("package.json")) return false;

  try {
    const modulesTime = statSync("node_modules").mtimeMs;
    const pkgTime = statSync("package.json").mtimeMs;
    const lockTime = existsSync("package-lock.json") ? statSync("package-lock.json").mtimeMs : 0;
    return pkgTime > modulesTime || lockTime > modulesTime;
  } catch {
    return true;
  }
}

function needsRebuild() {
  if (!existsSync("dist/index.js")) return true;
  if (!existsSync("src")) return false;

  try {
    const distTime = statSync("dist/index.js").mtimeMs;
    const srcTime = newestMtime("src");
    const configTime = existsSync("config") ? newestMtime("config") : 0;
    const pkgTime = existsSync("package.json") ? statSync("package.json").mtimeMs : 0;
    return srcTime > distTime || configTime > distTime || pkgTime > distTime;
  } catch {
    return true;
  }
}

if (needsInstall()) {
  console.log("[dreamliner] Installing dependencies (including build tools)…");
  run("npm", ["install", "--include=dev"]);
}

if (needsRebuild()) {
  console.log("[dreamliner] Source changed — rebuilding dist/…");
  run("npm", ["run", "build"]);
}

if (!existsSync("dist/index.js")) {
  console.error("[dreamliner] Build finished but dist/index.js is still missing.");
  process.exit(1);
}

console.log("[dreamliner] Starting…");
await import("./dist/index.js");
