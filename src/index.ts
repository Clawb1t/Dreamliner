import "dotenv/config";
import { createBot, registerSlashCommands } from "./bot.js";
import { configManager } from "./config/manager.js";
import { runMigrations } from "./scripts/migrate.js";
import { runPermissionRoleMigration } from "./scripts/migratePermissionRoles.js";
import { ensurePiperReady, resolvePiperVoicesDir } from "./plugins/tts/functions/piperSetup.js";
import { ensureVoicePackInstalled } from "./plugins/tts/functions/voiceCatalog.js";
import { getLogger } from "./core/logger.js";
const log = getLogger("boot");
const ttsLog = getLogger("tts");

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection:", reason);
});

// Without this, an uncaught synchronous throw anywhere (a bad plugin, a
// third-party dependency, whatever) has no listener and Node's default
// behavior kicks in: dump the stack and kill the process. Log it and keep
// the bot running instead of dying and relying on a process manager restart.
process.on("uncaughtException", (error, origin) => {
  log.error(`Uncaught exception (${origin}):`, error);
});

function shouldExportSchemaOnStart(): boolean {
  if (process.env.EXPORT_SCHEMA_ON_START === "true") return true;
  if (process.env.EXPORT_SCHEMA_ON_START === "false") return false;
  // Local source runs (`npm run dev` / tsx src/index.ts) — refresh schema for git push
  const entry = process.argv[1] ?? "";
  return (
    process.env.npm_lifecycle_event === "dev" ||
    /src[/\\]index\.[cm]?[tj]s$/.test(entry)
  );
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log.error("DISCORD_TOKEN is required.");
    process.exit(1);
  }

  if (shouldExportSchemaOnStart()) {
    try {
      const { exportGuildConfigSchema } = await import("./config/exportGuildConfigSchema.js");
      exportGuildConfigSchema();
      log.info("Exported guild config schema for the website editor.");
    } catch (error) {
      log.warn("Schema export failed:", error);
    }
  }

  runMigrations();

  try {
    // Seeds Dreamliner Roles for every guild and best-effort migrates old levels/overrides data.
    // Must run before createBot()/client.login() below — see migratePermissionRoles.ts's header
    // comment for why the ordering is load-bearing.
    runPermissionRoleMigration();
  } catch (error) {
    log.error("Permission role migration failed:", error);
  }

  try {
    // Bounded so a stuck download/network issue can't block the bot from ever coming online.
    // If it times out, setup keeps running in the background and /tts just isn't ready yet.
    const timeout = new Promise<{ ok: false; reason: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "Timed out after 5 minutes; continuing to try in the background." }), 5 * 60_000),
    );
    const piperReady = await Promise.race([ensurePiperReady(), timeout]);
    if (!piperReady.ok) {
      log.warn(`Piper TTS setup incomplete: ${piperReady.reason}`);
    }
  } catch (error) {
    log.warn("Piper TTS setup failed:", error);
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  if (clientId && process.env.REGISTER_COMMANDS_ON_START !== "false") {
    try {
      log.info("Registering slash commands…");
      await registerSlashCommands(token, clientId);
    } catch (error) {
      log.error("Failed to register slash commands:", error);
    }
  } else if (!clientId) {
    log.warn("DISCORD_CLIENT_ID missing — slash commands were not registered on start.");
  }

  const { client } = await createBot(configManager);
  await client.login(token);

  if (process.env.PIPER_INSTALL_VOICE_PACK !== "false") {
    // Fire-and-forget: this can be a large, slow download (dozens of voices per language), so
    // it runs after the bot is already online instead of blocking startup. /tts's voice
    // autocomplete just reads whatever's on disk, so voices show up as they finish.
    const families = (process.env.PIPER_LANGUAGES ?? "en,es,ja")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    void ensureVoicePackInstalled(resolvePiperVoicesDir(), families)
      .then((result) => {
        ttsLog.info(
          `Voice pack (${families.join(", ")}): installed ${result.installed.length}, already had ${result.skipped}` +
            (result.failed.length ? `, failed ${result.failed.length} (${result.failed.map((f) => f.voice).join(", ")})` : "") +
            ".",
        );
      })
      .catch((error) => {
        ttsLog.warn("Voice pack install failed:", error);
      });
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
