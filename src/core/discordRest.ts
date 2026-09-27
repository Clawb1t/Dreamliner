import { Agent } from "undici";

/**
 * Dedicated HTTP agent for every discord.js REST client.
 *
 * `@atproto/oauth-client-node` (Bluesky) loads undici v7/v8, which replace Node's global undici
 * dispatcher with a compatibility wrapper. `@discordjs/rest` sends through undici 6's `request()`
 * and falls back to that global dispatcher, and multipart bodies (any reply with a file, like
 * /rank and /stats charts) never finish sending through the wrapper, so Discord times out.
 * Giving REST its own undici 6 agent keeps it independent of whatever sets the global one.
 *
 * `undici` is pinned to the same version `@discordjs/rest` depends on; keep them in sync.
 */
export const discordRestAgent = new Agent();
