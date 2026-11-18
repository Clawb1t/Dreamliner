import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SafeFetchError, isBlockedAddress, resolveSafeTarget, safeFetch, type LookupFn } from "./safeFetch.js";

describe("isBlockedAddress", () => {
  it("blocks private, loopback, link-local, CGNAT and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.254", "0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.10"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "100.63.255.255", "100.128.0.1", "172.32.0.1"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("blocks loopback, unique-local, link-local and IPv4-mapped/translated IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:192.168.0.1", "::127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "[::1]"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it("allows public IPv6 and treats garbage as blocked", () => {
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
    assert.equal(isBlockedAddress("2a00:1450:4009:81f::200e"), false);
    assert.equal(isBlockedAddress("::ffff:8.8.8.8"), true, "mapped addresses are always refused (the ::ffff:0:0/96 range)");
    assert.equal(isBlockedAddress("not an ip"), true);
    assert.equal(isBlockedAddress("1.2.3.999"), true);
  });
});

describe("resolveSafeTarget", () => {
  it("refuses non-http schemes, credentials and low ports", async () => {
    await assert.rejects(resolveSafeTarget("file:///etc/passwd"), (e: unknown) => e instanceof SafeFetchError && e.code === "invalid_url");
    await assert.rejects(resolveSafeTarget("ftp://example.com/feed"), (e: unknown) => e instanceof SafeFetchError && e.code === "invalid_url");
    await assert.rejects(resolveSafeTarget("https://user:pass@example.com/"), (e: unknown) => e instanceof SafeFetchError && e.code === "invalid_url");
    await assert.rejects(resolveSafeTarget("http://example.com:22/"), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address");
  });

  it("refuses private IP literals, including IPv6-mapped ones", async () => {
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://100.64.0.10/", "http://2130706433/", "http://0x7f.1/"]) {
      await assert.rejects(resolveSafeTarget(url), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address", url);
    }
  });

  it("refuses names that resolve to a private address, or to any private address among public ones", async () => {
    const lookup: LookupFn = async (host) =>
      host === "rebind.example.com"
        ? [
            { address: "93.184.215.14", family: 4 },
            { address: "10.0.0.7", family: 4 },
          ]
        : host === "mapped.example.com"
          ? [{ address: "::ffff:192.168.0.10", family: 6 }]
          : [{ address: "127.0.0.1", family: 4 }];
    for (const url of ["https://loopback.example.com/feed", "https://rebind.example.com/feed", "https://mapped.example.com/feed"]) {
      await assert.rejects(resolveSafeTarget(url, { lookup }), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address", url);
    }
    await assert.rejects(resolveSafeTarget("http://localhost:8080/"), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address");
    await assert.rejects(resolveSafeTarget("http://printer.internal/"), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address");
  });

  it("pins the checked public address", async () => {
    const lookup: LookupFn = async () => [{ address: "93.184.215.14", family: 4 }];
    const target = await resolveSafeTarget("https://example.com/feed.xml", { lookup });
    assert.equal(target.address, "93.184.215.14");
  });
});

describe("safeFetch against a local server", () => {
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/feed") {
        res.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' });
        res.end("<rss><channel><title>ok</title></channel></rss>");
      } else if (req.url === "/conditional") {
        if (req.headers["if-none-match"] === '"v1"') {
          res.writeHead(304);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/xml", etag: '"v1"' });
          res.end("<rss/>");
        }
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      } else if (req.url === "/to-internal-name") {
        res.writeHead(301, { location: "http://intranet.example.org/secret" });
        res.end();
      } else if (req.url === "/to-mapped") {
        res.writeHead(307, { location: "http://[::ffff:127.0.0.1]:" + port + "/feed" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/xml" });
        const chunk = Buffer.alloc(64 * 1024, 120);
        let sent = 0;
        const pump = () => {
          while (sent < 4 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        pump();
      } else if (req.url === "/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
      } else if (req.url === "/ua") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(req.headers["user-agent"]));
      } else if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("late");
        }, 1500);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  // "feeds.example.test" stands in for a public host: DNS answers with the local server, and the
  // policy treats exactly that address as public. Everything else keeps the real policy.
  const lookup: LookupFn = async (host) => {
    if (host === "feeds.example.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "intranet.example.org") return [{ address: "10.20.30.40", family: 4 }];
    throw new Error("ENOTFOUND");
  };
  const isBlocked = (ip: string) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip));
  const base = () => `http://feeds.example.test:${port}`;

  it("fetches through the pinned address with the honest user agent", async () => {
    const result = await safeFetch(`${base()}/feed`, { lookup, isBlocked, accept: ["xml", "rss"] });
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /<title>ok<\/title>/);
    assert.equal(result.etag, '"v1"');
    const ua = await safeFetch(`${base()}/ua`, { lookup, isBlocked });
    assert.equal(ua.body.toString(), "Dreamliner-Feeds/1.0 (+https://dreamliner.site)");
  });

  it("sends conditional headers and reports 304 as not modified", async () => {
    const result = await safeFetch(`${base()}/conditional`, { lookup, isBlocked, etag: '"v1"' });
    assert.equal(result.notModified, true);
    assert.equal(result.body.length, 0);
  });

  it("re-checks every redirect hop: metadata IP, private DNS name, IPv6-mapped loopback", async () => {
    for (const path of ["/to-metadata", "/to-internal-name", "/to-mapped"]) {
      await assert.rejects(safeFetch(`${base()}${path}`, { lookup, isBlocked }), (e: unknown) => e instanceof SafeFetchError && e.code === "blocked_address", path);
    }
  });

  it("stops redirect loops", async () => {
    await assert.rejects(safeFetch(`${base()}/loop`, { lookup, isBlocked }), (e: unknown) => e instanceof SafeFetchError && e.code === "too_many_redirects");
  });

  it("caps the streamed body size", async () => {
    await assert.rejects(safeFetch(`${base()}/big`, { lookup, isBlocked, maxBytes: 1024 * 1024 }), (e: unknown) => e instanceof SafeFetchError && e.code === "too_large");
  });

  it("checks the content type when asked", async () => {
    await assert.rejects(safeFetch(`${base()}/html`, { lookup, isBlocked, accept: ["xml", "rss", "atom"] }), (e: unknown) => e instanceof SafeFetchError && e.code === "bad_content_type");
  });

  it("maps HTTP errors and timeouts", async () => {
    await assert.rejects(safeFetch(`${base()}/missing`, { lookup, isBlocked }), (e: unknown) => e instanceof SafeFetchError && e.code === "http" && e.status === 404);
    await assert.rejects(safeFetch(`${base()}/slow`, { lookup, isBlocked, timeoutMs: 300 }), (e: unknown) => e instanceof SafeFetchError && e.code === "timeout");
  });
});
