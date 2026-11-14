import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeYoutubeUrl } from "./youtube.js";

test("accepts YouTube video, short and playlist links", () => {
  assert.equal(normalizeYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(normalizeYoutubeUrl(" https://youtu.be/dQw4w9WgXcQ "), "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(normalizeYoutubeUrl("http://music.youtube.com/playlist?list=PL123"), "https://music.youtube.com/playlist?list=PL123");
  assert.ok(normalizeYoutubeUrl("https://m.youtube.com/watch?v=abc"));
});

test("refuses anything that isn't a YouTube link", () => {
  assert.equal(normalizeYoutubeUrl("lofi beats"), null);
  assert.equal(normalizeYoutubeUrl("https://soundcloud.com/x/y"), null);
  assert.equal(normalizeYoutubeUrl("https://youtube.com.evil.example/watch?v=x"), null);
  assert.equal(normalizeYoutubeUrl("http://127.0.0.1:4080/secret"), null);
  assert.equal(normalizeYoutubeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeYoutubeUrl("ytsearch:something"), null);
});
