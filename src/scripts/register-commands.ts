import "dotenv/config";
import { registerSlashCommands } from "../bot.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("scripts");

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    log.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
    process.exit(1);
  }
  await registerSlashCommands(token, clientId);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
