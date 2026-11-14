import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, signRadioPath, verifyRadioRequest } from "./media.js";

const KEY = "test-key";
const station = "a1b2c3d4e5f60718";
const track = "0f1e2d3c4b5a6978";

function url(exp: number, sig: string) {
  return { path: `/radio/media/${station}/${track}`, params: new URLSearchParams({ exp: String(exp), sig }) };
}

test("a correctly signed, unexpired URL verifies", () => {
  const exp = 10_000;
  const { path, params } = url(exp, signRadioPath(station, track, exp, KEY));
  assert.deepEqual(verifyRadioRequest(path, params, 5000, KEY), { stationId: station, trackId: track });
});

test("expired, tampered or malformed URLs are refused", () => {
  const exp = 10_000;
  const sig = signRadioPath(station, track, exp, KEY);
  assert.equal(verifyRadioRequest(url(exp, sig).path, url(exp, sig).params, 20_000, KEY), null);
  assert.equal(verifyRadioRequest(url(exp + 1, sig).path, url(exp + 1, sig).params, 5000, KEY), null);
  assert.equal(verifyRadioRequest(`/radio/media/${station}/${track}x`, url(exp, sig).params, 5000, KEY), null);
  assert.equal(verifyRadioRequest(`/radio/media/../etc/${track}`, url(exp, sig).params, 5000, KEY), null);
  assert.equal(verifyRadioRequest(url(exp, sig).path, url(exp, sig).params, 5000, "other-key"), null);
});

test("range parsing", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(parseRange("bytes=200-300", 100), false);
  assert.equal(parseRange("items=0-1", 100), null);
});
