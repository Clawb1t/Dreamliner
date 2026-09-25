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

export type BlueskyImage = { url: string; alt: string };

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
      .map((img) => ({ url: img.fullsize ?? img.thumb ?? "", alt: img.alt ?? "" }))
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
