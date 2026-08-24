/**
 * One-time migration: carries autodelete rules that were set with the old
 * `/autodelete set` command (stored in the `channel_autodelete` table) into
 * each guild's config as `plugins.autodelete.config.rules`, which is now the
 * only place the autodelete plugin reads rules from (see
 * src/plugins/autodelete/functions/config.ts).
 *
 * Safe to re-run: any guild that already has autodelete rules in its config
 * is left untouched, so running this twice (or after some guilds have
 * already been set up from the dashboard) does not clobber anything.
 *
 * Run with: npm run migrate:autodelete
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { getDb, closeDb } from "../db/client.js";
import { channelAutodelete } from "../db/schema.js";
import { configManager } from "../config/manager.js";

export async function migrateAutodeleteToConfig(): Promise<void> {
  const rows = getDb().select().from(channelAutodelete).all();
  if (!rows.length) {
    console.log("[migrate:autodelete] No legacy channel_autodelete rows found — nothing to migrate.");
    return;
  }

  const byGuild = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byGuild.get(row.guildId) ?? [];
    list.push(row);
    byGuild.set(row.guildId, list);
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [guildId, guildRows] of byGuild) {
    const config = await configManager.getEffectiveConfig(guildId);
    const existingRules = config.plugins.autodelete?.config?.rules;
    if (Array.isArray(existingRules) && existingRules.length > 0) {
      console.log(
        `[migrate:autodelete] Skipping guild ${guildId} — already has ${existingRules.length} rule(s) in config.`,
      );
      skipped += 1;
      continue;
    }

    const rules = guildRows.map((row) => ({
      enabled: true,
      name: "",
      channel_id: row.channelId,
      delay_seconds: row.delaySeconds,
    }));

    const result = await configManager.patchPluginConfig(
      guildId,
      "autodelete",
      { rules },
      "migration:autodelete-to-config",
    );

    if (!result.success) {
      console.error(`[migrate:autodelete] Failed to migrate guild ${guildId}:`, result.errors.join("; "));
      failed += 1;
      continue;
    }

    console.log(`[migrate:autodelete] Migrated ${rules.length} rule(s) for guild ${guildId}.`);
    migrated += 1;
  }

  console.log(
    `[migrate:autodelete] Done. Migrated ${migrated} guild(s), skipped ${skipped} already-migrated guild(s), ${failed} failure(s).`,
  );
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  migrateAutodeleteToConfig()
    .catch((error) => {
      console.error("[migrate:autodelete] Migration crashed:", error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
