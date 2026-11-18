/**
 * Fetching URLs that came from users (RSS feeds, image URLs) without letting them reach anything
 * private. Every request:
 *  - is http(s) only, on the default ports or any port above 1023 (never e.g. :22 or :25);
 *  - resolves the host itself and refuses private, loopback, link-local, CGNAT (100.64/10),
 *    multicast, reserved and IPv4-mapped/translated IPv6 addresses. If ANY address the name
 *    resolves to is blocked, the request is refused (so a name can't mix public and private);
 *  - connects to exactly the address that was checked (an undici Agent whose `lookup` returns the
 *    pinned IP), so DNS rebinding between the check and the connect can't redirect it;
 *  - follows at most `maxRedirects` redirects by hand, re-checking every hop;
 *  - streams the body with a hard size cap, and has an overall timeout;
 *  - optionally checks the content type, and sends conditional headers (ETag / Last-Modified).
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, request } from "undici";

export const FEEDS_USER_AGENT = "Dreamliner-Feeds/1.0 (+https://dreamliner.site)";
export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_TIMEOUT_MS = 15_000;

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "dns"
  | "timeout"
  | "too_large"
  | "bad_content_type"
  | "too_many_redirects"
  | "http"
  | "network";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly status: number | null;
  /** Seconds from a 429/503 Retry-After header, when present. */
  readonly retryAfterS: number | null;
  constructor(code: SafeFetchErrorCode, message: string, status: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

// ---------------------------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------------------------

// Separate lists: a BlockList holding IPv6 rules like ::ffff:0:0/96 also matches every plain IPv4
// address against them, so v4 and v6 are checked on their own lists.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4-compatible (deprecated)
  ["::ffff:0:0", 96], // IPv4-mapped (also checked by unwrapping below)
  ["::ffff:0:0:0", 96], // IPv4-translated
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["3fff::", 20], // documentation
  ["5f00::", 16], // SRv6 SIDs
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** 16 bytes of an IPv6 address (any textual form, including a dotted IPv4 tail), or null. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.trim().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    tail = parts;
    text = text.slice(0, -dotted[1]!.length) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":") : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

/** True when a request must never be made to this IP address. Unparseable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(clean.split("%")[0]!);
  if (family === 4) return blockedV4.check(clean, "ipv4");
  if (family !== 6) return true;
  const bytes = ipv6Bytes(clean);
  if (!bytes) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) carry an IPv4 address: judge that too.
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    const v4 = bytes.slice(12).join(".");
    if (blockedV4.check(v4, "ipv4")) return true;
  }
  const normalized = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16)).join(":");
  return blockedV6.check(normalized, "ipv6");
}

const BLOCKED_HOSTNAME = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

// ---------------------------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------------------------

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export type SafeFetchOptions = {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Accepted content types (substring match on the media type). Omit to accept anything. */
  accept?: string[];
  /** Conditional request: a 304 answer comes back as `notModified`. */
  etag?: string | null;
  lastModified?: string | null;
  /** Tests: replace DNS resolution. */
  lookup?: LookupFn;
  /** Tests: replace the address policy (return true to block). */
  isBlocked?: (address: string) => boolean;
};

export type SafeFetchResult = {
  status: number;
  /** The final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
};

const defaultLookup: LookupFn = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 24 * 3600);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.min(Math.round((at - Date.now()) / 1000), 24 * 3600));
  return null;
}

/** Validate a URL and pick the address to connect to. Throws SafeFetchError. */
export async function resolveSafeTarget(
  raw: string | URL,
  options: Pick<SafeFetchOptions, "lookup" | "isBlocked"> = {},
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SafeFetchError("invalid_url", "That isn't a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SafeFetchError("invalid_url", "Only http(s) URLs are allowed.");
  if (url.username || url.password) throw new SafeFetchError("invalid_url", "URLs with a username or password aren't allowed.");
  if (url.port) {
    const port = Number(url.port);
    if (port !== 80 && port !== 443 && port < 1024) throw new SafeFetchError("blocked_address", "That port isn't allowed.");
  }
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("invalid_url", "That URL has no host.");

  if (isIP(host)) {
    if (isBlocked(host)) throw new SafeFetchError("blocked_address", "That address isn't allowed.");
    return { url, address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  if (BLOCKED_HOSTNAME.test(host) || !host.includes(".")) throw new SafeFetchError("blocked_address", "That address isn't allowed.");

  let addresses: { address: string; family: number }[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(host);
  } catch {
    throw new SafeFetchError("dns", `Couldn't find ${host}.`);
  }
  if (!addresses.length) throw new SafeFetchError("dns", `Couldn't find ${host}.`);
  if (addresses.some((entry) => isBlocked(entry.address))) {
    throw new SafeFetchError("blocked_address", "That address isn't allowed.");
  }
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

function pinnedAgent(address: string, family: 4 | 6, timeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      // The connection goes to the address that was checked, whatever DNS says now.
      lookup: ((_hostname: string, opts: unknown, callback: (...args: unknown[]) => void) => {
        const all = Boolean(opts && typeof opts === "object" && (opts as { all?: boolean }).all);
        if (all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as unknown as import("node:net").LookupFunction,
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: 1,
    pipelining: 0,
  });
}

function contentTypeAllowed(contentType: string, accept: string[] | undefined): boolean {
  if (!accept?.length) return true;
  const media = contentType.split(";")[0]!.trim().toLowerCase();
  // Some feeds (and CDNs) send no type at all: let the parser decide.
  if (!media) return true;
  return accept.some((allowed) => media.includes(allowed.toLowerCase()));
}

/** Fetch a user-supplied URL safely. Throws SafeFetchError for every failure, including non-2xx. */
export async function safeFetch(raw: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = AbortSignal.timeout(timeoutMs);

  let current = String(raw);
  let method = options.method ?? "GET";
  let body = options.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolveSafeTarget(current, options);
    const agent = pinnedAgent(target.address, target.family, timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": FEEDS_USER_AGENT,
        accept: "*/*",
        "accept-encoding": "identity",
        ...(options.headers ?? {}),
      };
      if (hop === 0 && options.etag) headers["if-none-match"] = options.etag;
      if (hop === 0 && options.lastModified) headers["if-modified-since"] = options.lastModified;

      let response: Awaited<ReturnType<typeof request>>;
      try {
        response = await request(target.url, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
          dispatcher: agent,
          signal: deadline,
          maxRedirections: 0,
        } as Parameters<typeof request>[1]);
      } catch (error) {
        if (deadline.aborted) throw new SafeFetchError("timeout", "The request timed out.");
        const code = (error as { code?: string }).code ?? "";
        if (/TIMEOUT/i.test(code)) throw new SafeFetchError("timeout", "The request timed out.");
        throw new SafeFetchError("network", `Couldn't connect (${code || "network error"}).`);
      }

      const status = response.statusCode;
      const resHeaders = response.headers as Record<string, string | string[] | undefined>;

      if (status >= 300 && status < 400 && status !== 304) {
        await response.body.dump().catch(() => undefined);
        const location = headerValue(resHeaders, "location");
        if (!location) throw new SafeFetchError("http", `Redirect without a location (${status}).`, status);
        if (hop === maxRedirects) throw new SafeFetchError("too_many_redirects", "Too many redirects.");
        current = new URL(location, target.url).toString();
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const contentType = headerValue(resHeaders, "content-type") ?? "";
      const etag = headerValue(resHeaders, "etag");
      const lastModified = headerValue(resHeaders, "last-modified");

      if (status === 304) {
        await response.body.dump().catch(() => undefined);
        return { status, url: target.url.toString(), headers: flattenHeaders(resHeaders), contentType, body: Buffer.alloc(0), notModified: true, etag, lastModified };
      }
      if (status < 200 || status >= 300) {
        await response.body.dump().catch(() => undefined);
        throw new SafeFetchError("http", `The server answered ${status}.`, status, parseRetryAfter(headerValue(resHeaders, "retry-after")));
      }
      if (!contentTypeAllowed(contentType, options.accept)) {
        await response.body.dump().catch(() => undefined);
        throw new SafeFetchError("bad_content_type", `Unexpected content type (${contentType.split(";")[0]}).`, status);
      }
      const declared = Number(headerValue(resHeaders, "content-length") ?? 0);
      if (declared > maxBytes) {
        await response.body.dump().catch(() => undefined);
        throw new SafeFetchError("too_large", "The response is too large.", status);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          total += buf.length;
          if (total > maxBytes) {
            response.body.destroy();
            throw new SafeFetchError("too_large", "The response is too large.", status);
          }
          chunks.push(buf);
        }
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        if (deadline.aborted) throw new SafeFetchError("timeout", "The request timed out.");
        throw new SafeFetchError("network", "The connection dropped.");
      }
      return {
        status,
        url: target.url.toString(),
        headers: flattenHeaders(resHeaders),
        contentType,
        body: Buffer.concat(chunks),
        notModified: false,
        etag,
        lastModified,
      };
    } finally {
      void agent.close().catch(() => undefined);
    }
  }
  throw new SafeFetchError("too_many_redirects", "Too many redirects.");
}

/** safeFetch + JSON.parse. Throws SafeFetchError (code "http") for bodies that aren't JSON. */
export async function safeFetchJson<T>(url: string | URL, options: SafeFetchOptions = {}): Promise<{ data: T; result: SafeFetchResult }> {
  const result = await safeFetch(url, { accept: ["json", "javascript", "text/plain"], ...options });
  if (result.notModified) return { data: null as T, result };
  try {
    return { data: JSON.parse(result.body.toString("utf8")) as T, result };
  } catch {
    throw new SafeFetchError("http", "The response wasn't valid JSON.", result.status);
  }
}
