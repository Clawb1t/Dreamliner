import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRecentTrack } from "./lastfm.js";

const NO_ART_HASH = "2a96cbd8b46e442fc41c2b86b821562f";

function trackFixture(overrides: Record<string, unknown> = {}) {
  return {
    name: "Weird Fishes",
    url: "https://www.last.fm/music/Radiohead/_/Weird+Fishes",
    artist: { "#text": "Radiohead" },
    image: [
      { "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/abc123.png", size: "extralarge" },
    ],
    ...overrides,
  };
}

describe("parseRecentTrack", () => {
  it("marks a currently-playing track", () => {
    const track = parseRecentTrack({
      recenttracks: { track: [trackFixture({ "@attr": { nowplaying: "true" } })] },
    });
    assert.equal(track?.nowPlaying, true);
  });

  it("marks a plain recent scrobble as not playing", () => {
    const track = parseRecentTrack({ recenttracks: { track: [trackFixture()] } });
    assert.equal(track?.nowPlaying, false);
  });

  it("accepts a bare object instead of an array", () => {
    const track = parseRecentTrack({ recenttracks: { track: trackFixture() } });
    assert.equal(track?.name, "Weird Fishes");
  });

  it("returns null for an empty track list", () => {
    assert.equal(parseRecentTrack({ recenttracks: { track: [] } }), null);
  });

  it("returns null when recenttracks is missing", () => {
    assert.equal(parseRecentTrack({}), null);
    assert.equal(parseRecentTrack(undefined), null);
  });

  it("treats the placeholder art hash as no image", () => {
    const track = parseRecentTrack({
      recenttracks: {
        track: [
          trackFixture({
            image: [{ "#text": `https://lastfm.freetls.fastly.net/i/u/300x300/${NO_ART_HASH}.png`, size: "extralarge" }],
          }),
        ],
      },
    });
    assert.equal(track?.imageUrl, null);
  });

  it("returns real extralarge art", () => {
    const track = parseRecentTrack({ recenttracks: { track: [trackFixture()] } });
    assert.equal(track?.imageUrl, "https://lastfm.freetls.fastly.net/i/u/300x300/abc123.png");
  });

  it("constructs an artist URL that encodes special characters", () => {
    const track = parseRecentTrack({
      recenttracks: { track: [trackFixture({ artist: { "#text": "Sigur Rós" } })] },
    });
    assert.equal(track?.artistUrl, `https://www.last.fm/music/${encodeURIComponent("Sigur Rós")}`);

    const track2 = parseRecentTrack({
      recenttracks: { track: [trackFixture({ artist: { "#text": "AC/DC" } })] },
    });
    assert.equal(track2?.artistUrl, `https://www.last.fm/music/${encodeURIComponent("AC/DC")}`);
  });
});
