/**
 * Thin client for Bluesky's public AppView (native fetch, no auth, no API key). Used to resolve
 * accounts, hydrate posts that arrive over Jetstream, and read profiles. Everything the bot does
 * *as* a member (like, repost, follow) goes through that member's OAuth session instead, see
 * oauth.ts / actions.ts.
 */

export class BlueskyResolveError extends Error {}

const APPVIEW = "https://public.api.bsky.app/xrpc";
const REQUEST_TIMEOUT_MS = 8_000;

export type BlueskyActor = {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
};

export type BlueskyProfile = BlueskyActor & {
  description: string;
  bannerUrl: string | null;
  followersCount: number;
  followsCount: number;
  postsCount: number;
};

export type BlueskyPostKind = "post" | "reply" | "quote" | "repost";

export type BlueskyImage = { url: string; alt: string; /** Smaller CDN rendition, for dashboard thumbnails. */ thumbUrl?: string };

export type BlueskyPost = {
  uri: string;
  cid: string;
  url: string;
  author: BlueskyActor;
  text: string;
  createdAt: Date;
  /** Post, reply or quote, from the record itself. Reposts are a feed-level wrapper (see stream.ts). */
  kind: Exclude<BlueskyPostKind, "repost">;
  replyParentUri: string | null;
  images: BlueskyImage[];
  videoThumbnailUrl: string | null;
  external: { url: string; title: string; description: string; thumbUrl: string | null } | null;
  quoted: { author: BlueskyActor; text: string; url: string } | null;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
};

// ---------------------------------------------------------------------------------------------
// URLs and identifiers
// ---------------------------------------------------------------------------------------------

const POST_URL_RE =
  /https?:\/\/(?:www\.)?(?:bsky\.app|[a-z0-9-]+\.bsky\.social|staging\.bsky\.app)\/profile\/([A-Za-z0-9._:%-]+)\/post\/([A-Za-z0-9]+)/gi;

export function profileUrl(handleOrDid: string): string {
  return `https://bsky.app/profile/${handleOrDid}`;
}

export function postUrl(handleOrDid: string, rkey: string): string {
  return `https://bsky.app/profile/${handleOrDid}/post/${rkey}`;
}

/** Splits `at://did/collection/rkey`. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) return null;
  return { did: match[1]!, collection: match[2]!, rkey: match[3]! };
}

/** Parses one bsky.app post link into its author (handle or DID) and record key. */
export function parsePostUrl(url: string): { actor: string; rkey: string } | null {
  POST_URL_RE.lastIndex = 0;
  const match = POST_URL_RE.exec(url);
  if (!match) return null;
  return { actor: decodeURIComponent(match[1]!), rkey: match[2]! };
}

/** Every bsky.app post link in a piece of text, in order, de-duplicated. */
export function extractPostUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(POST_URL_RE)) found.add(match[0]);
  return [...found];
}

/**
 * Normalizes what a person types for an account (`@alice.bsky.social`, `alice`, a profile URL, or
 * a DID) into something `getProfile` accepts. A bare name with no dot is assumed to be on bsky.social.
 */
export function normalizeActorInput(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  const profileMatch = /bsky\.app\/profile\/([^/?#\s]+)/i.exec(value);
  if (profileMatch) value = decodeURIComponent(profileMatch[1]!);
  value = value.replace(/^@/, "").replace(/\/+$/, "");
  if (/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(value)) return value;
  value = value.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (!value.includes(".")) value = `${value}.bsky.social`;
  return value;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

async function xrpcGet<T>(method: string, params: Record<string, string | string[]>): Promise<T> {
  const url = new URL(`${APPVIEW}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new BlueskyResolveError(body?.message?.includes("not found") ? "Couldn't find that Bluesky account." : "Bluesky rejected that lookup.");
  }
  if (!res.ok) throw new Error(`Bluesky ${method} failed (${res.status}).`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Raw AppView shapes (only the fields used here)
// ---------------------------------------------------------------------------------------------

type RawActor = { did: string; handle: string; displayName?: string; avatar?: string };
type RawProfile = RawActor & {
  description?: string;
  banner?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
};
type RawEmbedView = {
  $type?: string;
  images?: { fullsize?: string; thumb?: string; alt?: string }[];
  thumbnail?: string;
  external?: { uri: string; title?: string; description?: string; thumb?: string };
  record?: RawEmbedRecord & { record?: RawEmbedRecord };
  media?: RawEmbedView;
};
type RawEmbedRecord = {
  $type?: string;
  uri?: string;
  author?: RawActor;
  value?: { text?: string };
};
type RawPostView = {
  uri: string;
  cid: string;
  author: RawActor;
  record: {
    text?: string;
    createdAt?: string;
    reply?: { parent?: { uri?: string } };
    embed?: { $type?: string };
  };
  embed?: RawEmbedView;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  indexedAt?: string;
};

function mapActor(raw: RawActor): BlueskyActor {
  return {
    did: raw.did,
    handle: raw.handle,
    displayName: raw.displayName?.trim() || raw.handle,
    avatarUrl: raw.avatar ?? null,
    url: profileUrl(raw.handle),
  };
}

function mapQuoted(record: RawEmbedRecord | undefined): BlueskyPost["quoted"] {
  if (!record?.author || !record.uri || !record.$type?.endsWith("#viewRecord")) return null;
  const parsed = parseAtUri(record.uri);
  const author = mapActor(record.author);
  return {
    author,
    text: record.value?.text ?? "",
    url: parsed ? postUrl(author.handle, parsed.rkey) : author.url,
  };
}

/** Pulls images / video / link card / quoted post out of an embed view, including recordWithMedia. */
function mapEmbed(view: RawEmbedView | undefined): Pick<BlueskyPost, "images" | "videoThumbnailUrl" | "external" | "quoted"> {
  const result: Pick<BlueskyPost, "images" | "videoThumbnailUrl" | "external" | "quoted"> = {
    images: [],
    videoThumbnailUrl: null,
    external: null,
    quoted: null,
  };
  if (!view) return result;
  const type = view.$type ?? "";

  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    result.quoted = mapQuoted(view.record?.record);
    return { ...mapEmbed(view.media), quoted: result.quoted };
  }
  if (type.startsWith("app.bsky.embed.record")) {
    result.quoted = mapQuoted(view.record);
    return result;
  }
  if (type.startsWith("app.bsky.embed.images")) {
    result.images = (view.images ?? [])
      .map((img) => ({ url: img.fullsize ?? img.thumb ?? "", alt: img.alt ?? "", thumbUrl: img.thumb ?? img.fullsize }))
      .filter((img) => img.url);
    return result;
  }
  if (type.startsWith("app.bsky.embed.video")) {
    result.videoThumbnailUrl = view.thumbnail ?? null;
    return result;
  }
  if (type.startsWith("app.bsky.embed.external") && view.external) {
    result.external = {
      url: view.external.uri,
      title: view.external.title ?? "",
      description: view.external.description ?? "",
      thumbUrl: view.external.thumb ?? null,
    };
  }
  return result;
}

export function mapPostView(raw: RawPostView): BlueskyPost {
  const author = mapActor(raw.author);
  const parsed = parseAtUri(raw.uri);
  const embed = mapEmbed(raw.embed);
  const recordEmbedType = raw.record.embed?.$type ?? "";
  const replyParentUri = raw.record.reply?.parent?.uri ?? null;
  const isQuote = recordEmbedType.startsWith("app.bsky.embed.record");
  return {
    uri: raw.uri,
    cid: raw.cid,
    url: parsed ? postUrl(author.handle, parsed.rkey) : author.url,
    author,
    text: raw.record.text ?? "",
    createdAt: new Date(raw.record.createdAt ?? raw.indexedAt ?? Date.now()),
    kind: replyParentUri ? "reply" : isQuote ? "quote" : "post",
    replyParentUri,
    ...embed,
    likeCount: raw.likeCount ?? 0,
    repostCount: raw.repostCount ?? 0,
    replyCount: raw.replyCount ?? 0,
    quoteCount: raw.quoteCount ?? 0,
  };
}

function mapProfile(raw: RawProfile): BlueskyProfile {
  return {
    ...mapActor(raw),
    description: raw.description ?? "",
    bannerUrl: raw.banner ?? null,
    followersCount: raw.followersCount ?? 0,
    followsCount: raw.followsCount ?? 0,
    postsCount: raw.postsCount ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------------------------

/** Resolves a handle, `@handle`, profile URL or DID to a full profile. */
export async function resolveActor(input: string): Promise<BlueskyProfile> {
  const actor = normalizeActorInput(input);
  if (!actor) throw new BlueskyResolveError("Enter a Bluesky handle like alice.bsky.social, a profile link, or a DID.");
  return getProfile(actor);
}

export async function getProfile(actor: string): Promise<BlueskyProfile> {
  return mapProfile(await xrpcGet<RawProfile>("app.bsky.actor.getProfile", { actor }));
}

/** Up to 25 posts by at-uri. Missing/deleted posts are simply absent from the result. */
export async function getPosts(uris: string[]): Promise<BlueskyPost[]> {
  if (!uris.length) return [];
  const data = await xrpcGet<{ posts: RawPostView[] }>("app.bsky.feed.getPosts", { uris: uris.slice(0, 25) });
  return data.posts.map(mapPostView);
}

export async function getPost(uri: string): Promise<BlueskyPost | null> {
  const [post] = await getPosts([uri]);
  return post ?? null;
}

/** The account's newest own post (no reposts), used for "Send test notification". */
export async function getLatestPost(did: string): Promise<BlueskyPost | null> {
  const data = await xrpcGet<{ feed: { post: RawPostView; reason?: unknown }[] }>("app.bsky.feed.getAuthorFeed", {
    actor: did,
    limit: "10",
    filter: "posts_no_replies",
  });
  const own = data.feed.find((item) => !item.reason);
  return own ? mapPostView(own.post) : null;
}

/** Turns a bsky.app post link into an at-uri, resolving the handle to a DID when needed. */
export async function resolvePostUrl(url: string): Promise<string | null> {
  const parsed = parsePostUrl(url);
  if (!parsed) return null;
  let did = parsed.actor;
  if (!did.startsWith("did:")) {
    const data = await xrpcGet<{ did: string }>("com.atproto.identity.resolveHandle", { handle: parsed.actor }).catch(
      () => null,
    );
    if (!data) return null;
    did = data.did;
  }
  return `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
}

// ---------------------------------------------------------------------------------------------
// Batch profiles, author feeds, search, lists and starter packs (dashboard features)
// ---------------------------------------------------------------------------------------------

/** Up to 25 profiles in one call (`app.bsky.actor.getProfiles`). Unknown actors are simply absent. */
export async function getProfiles(actors: string[]): Promise<BlueskyProfile[]> {
  if (!actors.length) return [];
  const data = await xrpcGet<{ profiles: RawProfile[] }>("app.bsky.actor.getProfiles", { actors: actors.slice(0, 25) });
  return data.profiles.map(mapProfile);
}

/** Any number of profiles, 25 per call, one call at a time (kind to the public AppView). */
export async function getProfilesBatched(actors: string[]): Promise<BlueskyProfile[]> {
  const unique = [...new Set(actors)];
  const out: BlueskyProfile[] = [];
  for (let i = 0; i < unique.length; i += 25) {
    out.push(...(await getProfiles(unique.slice(i, i + 25))));
  }
  return out;
}

/** The account's newest own posts (no reposts, no replies), newest first. */
export async function getAuthorFeed(actor: string, count = 3): Promise<BlueskyPost[]> {
  const data = await xrpcGet<{ feed: { post: RawPostView; reason?: unknown }[] }>("app.bsky.feed.getAuthorFeed", {
    actor,
    limit: String(Math.min(30, Math.max(count * 3, 10))),
    filter: "posts_no_replies",
  });
  return data.feed
    .filter((item) => !item.reason)
    .slice(0, count)
    .map((item) => mapPostView(item.post));
}

/** Name-as-you-type account search (`app.bsky.actor.searchActorsTypeahead`). */
export async function searchActorsTypeahead(query: string, limit = 8): Promise<BlueskyActor[]> {
  const q = query.trim().replace(/^@/, "");
  if (!q) return [];
  const data = await xrpcGet<{ actors: RawActor[] }>("app.bsky.actor.searchActorsTypeahead", {
    q,
    limit: String(Math.min(Math.max(limit, 1), 25)),
  });
  return data.actors.map(mapActor);
}

export type BlueskyCollectionKind = "list" | "starter_pack";

export type ParsedCollectionUrl =
  | { kind: BlueskyCollectionKind; actor: string; rkey: string }
  | { kind: "short_link"; code: string };

const COLLECTION_ACTOR_RE = /^[A-Za-z0-9._:%-]+$/;
const COLLECTION_RKEY_RE = /^[A-Za-z0-9._~:-]+$/;

/**
 * Reads a Bluesky list or starter pack link:
 * - `bsky.app/profile/<actor>/lists/<rkey>` (a list)
 * - `bsky.app/starter-pack/<actor>/<rkey>` or `bsky.app/start/<actor>/<rkey>` (a starter pack)
 * - `go.bsky.app/<code>` (a starter pack short link, resolved separately)
 * - the equivalent `at://` URIs
 */
export function parseCollectionUrl(input: string): ParsedCollectionUrl | null {
  const value = input.trim();
  if (!value) return null;

  const atMatch = /^at:\/\/([^/\s]+)\/app\.bsky\.graph\.(list|starterpack)\/([A-Za-z0-9._~:-]+)$/.exec(value);
  if (atMatch) {
    return { kind: atMatch[2] === "list" ? "list" : "starter_pack", actor: decodeURIComponent(atMatch[1]!), rkey: atMatch[3]! };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }

  if (host === "go.bsky.app") {
    return parts.length === 1 && /^[A-Za-z0-9_-]+$/.test(parts[0]!) ? { kind: "short_link", code: parts[0]! } : null;
  }
  if (host !== "bsky.app" && host !== "staging.bsky.app") return null;

  const actor = parts[1];
  if (!actor || !COLLECTION_ACTOR_RE.test(actor)) return null;
  if (parts[0] === "profile" && parts[2] === "lists" && parts[3] && COLLECTION_RKEY_RE.test(parts[3])) {
    return { kind: "list", actor, rkey: parts[3] };
  }
  if ((parts[0] === "starter-pack" || parts[0] === "start") && parts[2] && COLLECTION_RKEY_RE.test(parts[2])) {
    return { kind: "starter_pack", actor, rkey: parts[2] };
  }
  return null;
}

/** Follows a go.bsky.app short link to the starter pack it points at. */
async function resolveShortLink(code: string): Promise<ParsedCollectionUrl | null> {
  const res = await fetch(`https://go.bsky.app/${encodeURIComponent(code)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  const location = res?.headers.get("location");
  if (!location) return null;
  let target: string;
  try {
    target = new URL(location, "https://bsky.app").toString();
  } catch {
    return null;
  }
  const parsed = parseCollectionUrl(target);
  return parsed && parsed.kind !== "short_link" ? parsed : null;
}

async function resolveDid(actor: string): Promise<string> {
  if (actor.startsWith("did:")) return actor;
  const data = await xrpcGet<{ did: string }>("com.atproto.identity.resolveHandle", { handle: actor.toLowerCase() });
  return data.did;
}

export type BlueskyCollection = {
  kind: BlueskyCollectionKind;
  name: string;
  description: string;
  creator: BlueskyActor;
  avatarUrl: string | null;
  url: string;
  /** Members Bluesky reports; `members` is shorter when it was capped. */
  total: number;
  members: BlueskyActor[];
  truncated: boolean;
};

type RawListView = {
  uri: string;
  name?: string;
  description?: string;
  avatar?: string;
  creator: RawActor;
  listItemCount?: number;
};

/** Members of a list, up to `cap`, 100 per page. */
async function listMembers(
  listUri: string,
  cap: number,
): Promise<{ list: RawListView | null; members: BlueskyActor[]; truncated: boolean }> {
  const members: BlueskyActor[] = [];
  let cursor: string | undefined;
  let list: RawListView | null = null;
  let truncated = false;
  for (let page = 0; page < 10; page++) {
    const data = await xrpcGet<{ list: RawListView; items: { subject: RawActor }[]; cursor?: string }>("app.bsky.graph.getList", {
      list: listUri,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    list ??= data.list;
    for (const item of data.items) {
      if (members.length >= cap) {
        truncated = true;
        break;
      }
      members.push(mapActor(item.subject));
    }
    cursor = data.items.length ? data.cursor : undefined;
    if (!cursor || truncated) break;
    if (members.length >= cap) {
      truncated = true;
      break;
    }
  }
  return { list, members, truncated };
}

function dedupeActors(actors: BlueskyActor[]): BlueskyActor[] {
  const seen = new Set<string>();
  return actors.filter((actor) => {
    if (seen.has(actor.did)) return false;
    seen.add(actor.did);
    return true;
  });
}

/** Resolves a list or starter pack link to its name and members (de-duplicated, capped at `cap`). */
export async function resolveCollection(input: string, cap = 150): Promise<BlueskyCollection> {
  let parsed = parseCollectionUrl(input);
  if (parsed?.kind === "short_link") parsed = await resolveShortLink(parsed.code);
  if (!parsed || parsed.kind === "short_link") {
    throw new BlueskyResolveError("Paste a Bluesky list link (bsky.app/profile/.../lists/...) or a starter pack link.");
  }
  const did = await resolveDid(parsed.actor);

  if (parsed.kind === "list") {
    const uri = `at://${did}/app.bsky.graph.list/${parsed.rkey}`;
    const { list, members, truncated } = await listMembers(uri, cap);
    if (!list) throw new BlueskyResolveError("Couldn't find that list.");
    const creator = mapActor(list.creator);
    return {
      kind: "list",
      name: list.name?.trim() || "Untitled list",
      description: list.description ?? "",
      creator,
      avatarUrl: list.avatar ?? null,
      url: `https://bsky.app/profile/${creator.handle}/lists/${parsed.rkey}`,
      total: list.listItemCount ?? members.length,
      members: dedupeActors(members),
      truncated,
    };
  }

  const uri = `at://${did}/app.bsky.graph.starterpack/${parsed.rkey}`;
  const data = await xrpcGet<{
    starterPack: {
      uri: string;
      creator: RawActor;
      record?: { name?: string; description?: string };
      list?: { uri: string; listItemCount?: number };
    };
  }>("app.bsky.graph.getStarterPack", { starterPack: uri });
  const pack = data.starterPack;
  const creator = mapActor(pack.creator);
  const { members, truncated } = pack.list?.uri ? await listMembers(pack.list.uri, cap) : { members: [], truncated: false };
  return {
    kind: "starter_pack",
    name: pack.record?.name?.trim() || "Starter pack",
    description: pack.record?.description ?? "",
    creator,
    avatarUrl: creator.avatarUrl,
    url: `https://bsky.app/starter-pack/${creator.handle}/${parsed.rkey}`,
    total: pack.list?.listItemCount ?? members.length,
    members: dedupeActors(members),
    truncated,
  };
}
