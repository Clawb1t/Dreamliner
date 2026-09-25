/**
 * Prints fresh secrets for Bluesky account connections. Paste them into .env:
 *   BLUESKY_OAUTH_PRIVATE_JWK  ES256 signing key for the OAuth client (production only)
 *   BLUESKY_SESSION_SECRET     AES-256 key that encrypts stored Bluesky sessions
 * Rotating the session secret signs every member out of Bluesky; rotating the JWK does not.
 */
import { randomBytes } from "node:crypto";
import { JoseKey } from "@atproto/oauth-client-node";

const key = await JoseKey.generate(["ES256"], "dreamliner-1");
const jwk = key.privateJwk;
if (!jwk) throw new Error("Generated key has no private JWK.");

// Pin the algorithm so the key is only ever used for ES256 signatures.
console.log(`BLUESKY_OAUTH_PRIVATE_JWK='${JSON.stringify({ ...jwk, alg: "ES256" })}'`);
console.log(`BLUESKY_SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
