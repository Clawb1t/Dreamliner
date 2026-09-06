import type { Guild } from "discord.js";
import type { EvidenceCapture, EvidenceSource, ListEvidenceQuery } from "../core/evidence.js";
import { listEvidenceCaptures } from "../core/evidence.js";

export type WebPerson = {
  id: string;
  name: string;
  username: string | null;
  avatar: string | null;
};

export type WebEvidenceCapture = Omit<EvidenceCapture, "userId" | "capturedBy"> & {
  user: WebPerson;
  capturedBy: WebPerson | null;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const SOURCES: EvidenceSource[] = ["case", "manual"];

export function parseWebEvidenceQuery(url: URL): ListEvidenceQuery {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const sourceRaw = url.searchParams.get("source");
  const source = SOURCES.includes(sourceRaw as EvidenceSource) ? (sourceRaw as EvidenceSource) : undefined;
  const caseIdRaw = url.searchParams.get("caseId");
  const caseId = caseIdRaw && Number.isFinite(Number(caseIdRaw)) ? Number(caseIdRaw) : undefined;
  return {
    userId: url.searchParams.get("target")?.trim() || undefined,
    caseId,
    source,
    limit,
    offset,
  };
}

async function resolvePerson(guild: Guild, userId: string | null): Promise<WebPerson | null> {
  if (!userId) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  return {
    id: userId,
    name: member?.displayName ?? user?.username ?? userId,
    username: user?.username ?? null,
    avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
  };
}

async function decoratePerson(guild: Guild, userId: string): Promise<WebPerson> {
  return (await resolvePerson(guild, userId)) ?? { id: userId, name: userId, username: null, avatar: null };
}

export async function listWebEvidence(
  guild: Guild,
  query: ListEvidenceQuery,
): Promise<{ captures: WebEvidenceCapture[]; total: number }> {
  const { captures, total } = await listEvidenceCaptures(guild, query);
  const decorated = await Promise.all(
    captures.map(async (capture): Promise<WebEvidenceCapture> => {
      const { userId, capturedBy, ...rest } = capture;
      return {
        ...rest,
        user: await decoratePerson(guild, userId),
        capturedBy: await resolvePerson(guild, capturedBy),
      };
    }),
  );
  return { captures: decorated, total };
}
