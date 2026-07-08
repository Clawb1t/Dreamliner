import "dotenv/config";
import { registerSlashCommands } from "../bot.js";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
    process.exit(1);
  }
  await registerSlashCommands(token, clientId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
