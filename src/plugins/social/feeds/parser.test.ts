import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFeedBody, parseFeed, FeedParseError } from "./parser.js";
import { dedupeKey, escapeDiscord, normalizeLink, summarize } from "./text.js";

/** Fixtures are real responses saved on 2026-11-18 (trimmed to their first few items). */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

describe("RSS 2.0", () => {
  it("parses the PlayStation Blog: guid keys, media:thumbnail images, categories, authors", () => {
    const feed = parseFeed(fixture("playstation.rss"), "https://blog.playstation.com/feed/", "application/rss+xml; charset=UTF-8");
    assert.equal(feed.format, "rss");
    assert.equal(feed.title, "PlayStation.Blog");
    assert.ok(feed.items.length >= 3);
    const first = feed.items[0]!;
    assert.match(first.key, /^urn:uuid:/);
    assert.match(first.url, /^https:\/\/blog\.playstation\.com\/2026\//);
    assert.match(first.imageUrl ?? "", /^https:\/\//);
    assert.ok(first.publishedAt instanceof Date);
    assert.ok(first.tags.length > 0);
    assert.ok(first.author);
  });

  it("keeps the summary short and never the full article", () => {
    for (const name of ["playstation.rss", "xbox.rss", "pcgamer.rss", "eurogamer.rss"]) {
      const feed = parseFeed(fixture(name), "https://example.com/feed");
      for (const item of feed.items) {
        assert.ok(item.summary.length <= 320, `${name}: ${item.summary.length}`);
        assert.doesNotMatch(item.summary, /<[a-z][^>]*>/i, `${name}: html left in summary`);
      }
    }
  });

  it("resolves Bungie's relative links against the feed URL and reads its custom <image> tag", () => {
    const feed = parseFeed(fixture("bungie.rss"), "https://www.bungie.net/en/rss/News");
    const first = feed.items[0]!;
    assert.equal(first.key, "blt6df00070786020bf");
    assert.equal(first.url, "https://www.bungie.net/7/en/News/Article/dev_deep_dive_expedition_phase_1");
    assert.match(first.imageUrl ?? "", /^https:\/\/images\.contentstack\.io\/.+Expedition_Header_1080x1080\.jpg$/);
  });

  it("takes the first article <img> but skips emoji images (Roblox DevForum)", () => {
    const feed = parseFeed(fixture("roblox-devforum.rss"), "https://devforum.roblox.com/c/updates/announcements/36.rss");
    for (const item of feed.items) assert.doesNotMatch(item.imageUrl ?? "", /\/emoji\//);
  });

  it("reads enclosure images", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://ex.com/</link>
      <item><title>A &amp; B</title><link>https://ex.com/a?utm_source=rss</link><enclosure url="/img/a.jpg" type="image/jpeg" length="1"/>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description><pubDate>Tue, 17 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const item = parseFeed(xml, "https://ex.com/feed").items[0]!;
    assert.equal(item.title, "A & B");
    assert.equal(item.imageUrl, "https://ex.com/img/a.jpg");
    assert.equal(item.summary, "Hello world");
    assert.equal(item.key, "https://ex.com/a", "no guid: the normalised link, utm stripped");
  });
});

describe("Atom", () => {
  it("parses GitHub releases (entry ids, alternate links, media:thumbnail)", () => {
    const feed = parseFeed(fixture("github-releases.atom"), "https://github.com/sharkdp/fd/releases.atom");
    assert.equal(feed.format, "atom");
    const first = feed.items[0]!;
    assert.match(first.key, /^tag:github\.com,2008:Repository\/\d+\//);
    assert.match(first.url, /^https:\/\/github\.com\/sharkdp\/fd\/releases\/tag\//);
    assert.ok(first.publishedAt);
  });

  it("parses The Verge (Atom with media and categories)", () => {
    const feed = parseFeed(fixture("verge-games.atom"), "https://www.theverge.com/rss/games/index.xml");
    assert.equal(feed.format, "atom");
    assert.ok(feed.items.every((i) => i.url.startsWith("https://www.theverge.com/")));
    assert.ok(feed.items.some((i) => i.imageUrl));
  });

  it("parses Statuspage history (GitHub status Atom, Discord status RSS)", () => {
    const github = parseFeed(fixture("status-github.atom"), "https://www.githubstatus.com/history.atom");
    assert.match(github.items[0]!.url, /^https:\/\/www\.githubstatus\.com\/incidents\//);
    const discord = parseFeed(fixture("status-discord.rss"), "https://discordstatus.com/history.rss");
    assert.match(discord.items[0]!.url, /^https:\/\/discordstatus\.com\/incidents\//);
    assert.ok(discord.items[0]!.summary.length > 0);
  });
});

describe("charsets", () => {
  it("decodes UTF-16 LE with a BOM (as minecraft.net serves its feeds)", () => {
    const utf16 = fixture("nintendo-jp-utf16le.xml");
    assert.equal(utf16[0], 0xff);
    const viaUtf16 = parseFeed(utf16, "https://www.nintendo.co.jp/news/whatsnew.xml");
    const viaUtf8 = parseFeed(fixture("nintendo-jp.xml"), "https://www.nintendo.co.jp/news/whatsnew.xml");
    assert.equal(viaUtf16.title, "任天堂ホームページ更新情報");
    assert.deepEqual(
      viaUtf16.items.map((i) => [i.key, i.title]),
      viaUtf8.items.map((i) => [i.key, i.title]),
    );
  });

  it("decodes UTF-16 BE and a declared single-byte charset", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><rss><channel><title>Café</title></channel></rss>';
    const le = Buffer.from(xml, "utf16le");
    const be = Buffer.alloc(le.length + 2);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 0; i < le.length; i += 2) {
      be[i + 2] = le[i + 1]!;
      be[i + 3] = le[i]!;
    }
    assert.match(decodeFeedBody(be), /Café/);
    const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf\xe9</title></channel></rss>', "latin1");
    assert.equal(parseFeed(latin1, "https://ex.com/").title, "Café");
  });
});

describe("safety and errors", () => {
  it("rejects HTML pages and garbage with a clear message", () => {
    assert.throws(() => parseFeed("<!doctype html><html><head></head><body>hi</body></html>", "https://ex.com/"), FeedParseError);
    assert.throws(() => parseFeed("not xml at all", "https://ex.com/"), FeedParseError);
  });

  it("ignores DOCTYPE entity definitions (no entity expansion)", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
      <rss><channel><title>T</title><item><title>&b;</title><link>https://ex.com/1</link></item></channel></rss>`;
    const feed = parseFeed(xml, "https://ex.com/");
    assert.equal(feed.items.length, 1);
    assert.ok(feed.items[0]!.title.length < 40);
  });

  it("escapes Discord markdown and mentions in titles and summaries", () => {
    const xml = `<rss><channel><title>T</title><item><title>**Bold** @everyone</title><link>https://ex.com/1</link>
      <description>&lt;@123456789012345678&gt; [click](https://evil.example) # heading</description></item></channel></rss>`;
    const item = parseFeed(xml, "https://ex.com/").items[0]!;
    assert.equal(item.title, "\\*\\*Bold\\*\\* @\u200beveryone");
    assert.ok(!item.summary.includes("<@"));
    assert.ok(item.summary.includes("\\[click\\]"));
  });

  it("drops javascript: and data: links", () => {
    const xml = `<rss><channel><title>T</title><item><title>x</title><link>javascript:alert(1)</link><guid>g1</guid></item></channel></rss>`;
    assert.equal(parseFeed(xml, "https://ex.com/").items[0]!.url, "");
  });
});

describe("text helpers", () => {
  it("dedupe keys prefer guid, then id, then the normalised link, then a hash", () => {
    assert.equal(dedupeKey({ guid: "g", id: "i", link: "https://a/b" }), "g");
    assert.equal(dedupeKey({ id: "i", link: "https://a/b" }), "i");
    assert.equal(dedupeKey({ link: "https://A.com/b/?utm_medium=x&q=1#top" }), "https://a.com/b?q=1");
    assert.match(dedupeKey({ title: "t", date: "d" }), /^h:[0-9a-f]{32}$/);
    assert.equal(dedupeKey({ title: "t", date: "d" }), dedupeKey({ title: "t", date: "d" }));
  });

  it("normalises links and summarises at a word boundary", () => {
    assert.equal(normalizeLink("https://ex.com/a/?fbclid=1"), "https://ex.com/a");
    const long = `<p>${"word ".repeat(200)}</p>`;
    const summary = summarize(long);
    assert.ok(summary.length <= 300);
    assert.ok(summary.endsWith("…"));
    assert.equal(escapeDiscord("a_b https://x.com/a_b"), "a\\_b https://x.com/a_b");
  });
});
