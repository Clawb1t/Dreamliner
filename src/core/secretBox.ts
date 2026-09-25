import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing for secrets stored at rest (e.g. Bluesky OAuth sessions, which hold refresh
 * tokens and a DPoP private key). Output is `v1.<iv>.<tag>.<ciphertext>`, all base64url, so a
 * tampered or truncated value fails to open instead of decrypting to garbage.
 */
const VERSION = "v1";

export class SecretBoxError extends Error {}

/** Parses a 32-byte key given as base64 / base64url (what `npm run bluesky:keys` prints). */
export function parseSecretKey(raw: string | undefined | null): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? key : null;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function open(sealed: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, dataRaw] = sealed.split(".");
  if (version !== VERSION || !ivRaw || !tagRaw || dataRaw === undefined) {
    throw new SecretBoxError("Unrecognized sealed value.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("Sealed value failed authentication.");
  }
}
