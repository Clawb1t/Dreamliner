import "dotenv/config";
import { createBot } from "./bot.js";
import { configManager } from "./config/manager.js";
import { runMigrations } from "./scripts/migrate.js";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN is required.");
    process.exit(1);
  }

  runMigrations();

  const { client } = await createBot(configManager);
  await client.login(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
