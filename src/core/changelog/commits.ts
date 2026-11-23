import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeFetch, SafeFetchError } from "../safeFetch.js";
import { getLogger } from "../logger.js";
import { areasFromPaths, type ChangelogCommit } from "./rules.js";

const log = getLogger("changelog");
const execFileAsync = promisify(execFile);

/**
 * Where the changelog's commits come from: the GitHub commits API for the bot's repo, or (local
 * development, GitHub unreachable) `git log` in this checkout. GITHUB_TOKEN is optional: it lifts the
 * unauthenticated limit of 60 requests an hour and is needed if the repo is ever made private.
 */

export const CHANGELOG_REPO = (process.env.CHANGELOG_GITHUB_REPO?.trim() || "Clawb1t/Dreamliner").replace(/^\/+|\/+$/g, "");

const API = "https://api.github.com";
/** Pages of 100 commits read per sync at most (a backfill of the whole history fits). */
const MAX_PAGES = 5;
/** Per-commit file lookups per call, and the remaining-quota floor under which they stop. */
const MAX_DETAIL_LOOKUPS = 60;
const RATE_FLOOR = 8;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dreamliner-changelog",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function githubJson<T>(path: string): Promise<{ data: T; remaining: number | null }> {
  const result = await safeFetch(`${API}${path}`, {
    headers: githubHeaders(),
    accept: ["json"],
    timeoutMs: 15_000,
    maxBytes: 8 * 1024 * 1024,
  });
  const remainingRaw = result.headers["x-ratelimit-remaining"];
  const remaining = remainingRaw != null && remainingRaw !== "" ? Number(remainingRaw) : null;
  return { data: JSON.parse(result.body.toString("utf8")) as T, remaining };
}

export type RepoAccess = { reachable: boolean; private: boolean | null; status: number | null; error?: string };

let repoAccessCache: { value: RepoAccess; until: number } | null = null;

/** Whether the repo can be read (and is public). Cached for six hours. */
export async function checkRepoAccess(force = false): Promise<RepoAccess> {
  if (!force && repoAccessCache && repoAccessCache.until > Date.now()) return repoAccessCache.value;
  let value: RepoAccess;
  try {
    const { data } = await githubJson<{ private?: boolean }>(`/repos/${CHANGELOG_REPO}`);
    value = { reachable: true, private: data.private === true, status: 200 };
  } catch (error) {
    const status = error instanceof SafeFetchError ? (error.status ?? null) : null;
    value = { reachable: false, private: null, status, error: error instanceof Error ? error.message : String(error) };
  }
  repoAccessCache = { value, until: Date.now() + (value.reachable ? 6 : 0.5) * 3_600_000 };
  return value;
}

/** The last known visibility, without a network call (null until the first check). */
export function knownRepoIsPublic(): boolean {
  return repoAccessCache?.value.reachable === true && repoAccessCache.value.private === false;
}

type GithubCommit = {
  sha: string;
  commit: { message: string; author?: { date?: string } | null; committer?: { date?: string } | null };
  parents?: unknown[];
  files?: { filename: string }[];
};

async function fetchGithubCommits(sinceMs: number | null): Promise<ChangelogCommit[]> {
  const commits: ChangelogCommit[] = [];
  const since = sinceMs ? `&since=${encodeURIComponent(new Date(sinceMs).toISOString())}` : "";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await githubJson<GithubCommit[]>(`/repos/${CHANGELOG_REPO}/commits?per_page=100&page=${page}${since}`);
    if (!Array.isArray(data)) break;
    for (const item of data) {
      // Merge commits repeat work that's already in their parents.
      if ((item.parents?.length ?? 1) > 1) continue;
      const date = item.commit.author?.date ?? item.commit.committer?.date;
      if (!item.sha || !date) continue;
      commits.push({ sha: item.sha, date: new Date(date).toISOString(), message: item.commit.message ?? "", areas: null });
    }
    if (data.length < 100) break;
  }
  return commits;
}

function localRepoRoot(): string | null {
  const root = process.env.CHANGELOG_LOCAL_REPO?.trim() || process.cwd();
  return existsSync(join(root, ".git")) ? root : null;
}

const RS = "\x1e";
const US = "\x1f";

async function fetchLocalCommits(root: string, sinceMs: number | null): Promise<ChangelogCommit[]> {
  const args = ["-C", root, "log", "--no-merges", `--format=${RS}%H${US}%aI${US}%B${US}`, "--name-only"];
  if (sinceMs) args.push(`--since=${new Date(sinceMs).toISOString()}`);
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const commits: ChangelogCommit[] = [];
  for (const chunk of stdout.split(RS)) {
    if (!chunk.trim()) continue;
    const [sha, date, message, files] = chunk.split(US);
    if (!sha || !date) continue;
    const paths = (files ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    commits.push({ sha: sha.trim(), date: new Date(date.trim()).toISOString(), message: (message ?? "").trim(), areas: areasFromPaths(paths) });
  }
  return commits;
}

export type CommitSource = "github" | "local";

/**
 * Commits since `sinceMs` (all of them when null). CHANGELOG_SOURCE=local|github forces one source;
 * by default GitHub is tried first and the local checkout is the fallback.
 */
export async function fetchChangelogCommits(sinceMs: number | null): Promise<{ commits: ChangelogCommit[]; source: CommitSource }> {
  const mode = (process.env.CHANGELOG_SOURCE ?? "auto").trim().toLowerCase();
  const root = localRepoRoot();
  if (mode !== "local") {
    try {
      return { commits: await fetchGithubCommits(sinceMs), source: "github" };
    } catch (error) {
      if (mode === "github" || !root) throw error;
      log.warn(`GitHub unreachable (${error instanceof Error ? error.message : error}); reading local git history.`);
    }
  }
  if (!root) throw new Error("No local git checkout to read commits from.");
  return { commits: await fetchLocalCommits(root, sinceMs), source: "local" };
}

/**
 * Fills in `areas` for commits that don't have them yet: from the local checkout when it has the
 * commit, otherwise the per-commit GitHub API (bounded, and stops before the rate limit runs out).
 * Commits it can't look up keep `areas: null`; the message alone is still enough to write from.
 */
export async function fillCommitAreas(commits: ChangelogCommit[]): Promise<ChangelogCommit[]> {
  const missing = commits.filter((c) => c.areas == null);
  if (!missing.length) return commits;
  const found = new Map<string, string[]>();
  const root = localRepoRoot();
  if (root) {
    for (const commit of missing) {
      try {
        const { stdout } = await execFileAsync("git", ["-C", root, "show", "--name-only", "--format=", commit.sha], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        found.set(commit.sha, areasFromPaths(stdout.split("\n").map((l) => l.trim()).filter(Boolean)));
      } catch {
        // Not in this checkout.
      }
    }
  }
  let lookups = 0;
  for (const commit of missing) {
    if (found.has(commit.sha) || lookups >= MAX_DETAIL_LOOKUPS) continue;
    lookups++;
    try {
      const { data, remaining } = await githubJson<GithubCommit>(`/repos/${CHANGELOG_REPO}/commits/${encodeURIComponent(commit.sha)}`);
      found.set(commit.sha, areasFromPaths((data.files ?? []).map((f) => f.filename)));
      if (remaining != null && remaining < RATE_FLOOR) break;
    } catch (error) {
      log.warn(`Couldn't read changed files for a commit: ${error instanceof Error ? error.message : error}`);
      break;
    }
  }
  return commits.map((c) => (c.areas == null && found.has(c.sha) ? { ...c, areas: found.get(c.sha)! } : c));
}
