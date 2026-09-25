import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { open, parseSecretKey, seal, SecretBoxError } from "./secretBox.js";

test("seal/open round trips", () => {
  const key = randomBytes(32);
  const sealed = seal('{"refresh":"abc"}', key);
  assert.equal(open(sealed, key), '{"refresh":"abc"}');
  assert.notEqual(seal("same", key), seal("same", key), "fresh IV per seal");
});

test("open rejects a tampered value or the wrong key", () => {
  const key = randomBytes(32);
  const sealed = seal("secret", key);
  const parts = sealed.split(".");
  const flipped = Buffer.from(parts[3]!, "base64url");
  flipped[0] = flipped[0]! ^ 1;
  parts[3] = flipped.toString("base64url");
  assert.throws(() => open(parts.join("."), key), SecretBoxError);
  assert.throws(() => open(sealed, randomBytes(32)), SecretBoxError);
  assert.throws(() => open("garbage", key), SecretBoxError);
});

test("parseSecretKey accepts base64 and base64url 32-byte keys only", () => {
  const key = randomBytes(32);
  assert.deepEqual(parseSecretKey(key.toString("base64")), key);
  assert.deepEqual(parseSecretKey(key.toString("base64url")), key);
  assert.equal(parseSecretKey(randomBytes(16).toString("base64")), null);
  assert.equal(parseSecretKey(""), null);
  assert.equal(parseSecretKey(undefined), null);
});
