import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeMp3, RADIO_CHUNK_BYTES, RADIO_MAX_FILE_BYTES } from "./uploads.js";

test("recognises MP3 headers (ID3 tag or MPEG frame sync)", () => {
  assert.equal(looksLikeMp3(Buffer.from("ID3\u0004\u0000", "latin1")), true);
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x64])), true);
  assert.equal(looksLikeMp3(Buffer.from("RIFF....WAVE", "latin1")), false);
  assert.equal(looksLikeMp3(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(looksLikeMp3(Buffer.alloc(0)), false);
});

test("a chunk fits under Vercel's 4.5MB body limit once base64-encoded", () => {
  assert.ok(Math.ceil((RADIO_CHUNK_BYTES * 4) / 3) + 200 < 4.5 * 1024 * 1024);
  assert.equal(Math.ceil(RADIO_MAX_FILE_BYTES / RADIO_CHUNK_BYTES), 34);
});
